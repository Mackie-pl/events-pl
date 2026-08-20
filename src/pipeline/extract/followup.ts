/**
 * Followupy: podstrony, PDF-y i plakaty dociągane OBOK strony źródła.
 *
 * Wydzielone z process-source.ts, kiedy ta ścieżka przestała być „jeszcze jeden fetch i model":
 * ma dziś trzy warstwy odsiewu, każdą na inne pytanie, i tylko razem tłumaczą, dlaczego
 * followup bywa darmowy.
 *
 *   1. WALIDATORY HTTP (304) — czy w ogóle pobierać. Najtańsze, ale serwery bywają na nie głuche.
 *   2. HASH TREŚCI pod tym samym adresem — czy ta podstrona się zmieniła od wczoraj.
 *   3. HASH TREŚCI STRONY ŹRÓDŁA — czy to nie jest, przypadkiem, ta sama strona pod innym
 *      adresem. Nowe i najbardziej zaskakujące: `mosina.pl/wydarzenia` i `…?page=1` oddają
 *      bajt w bajt te same 406 940 bajtów, `czerwonak.pl/mieszkaniec/kalendarz` to samo,
 *      co `/pl/mieszkaniec/kalendarz`.
 *
 * Dopiero za nimi stoi ścieżka blokowa — ta sama, którą chodzi strona źródła. Do 2026-08
 * followupy jej NIE MIAŁY i były jedynym miejscem w potoku płacącym pełną stawkę za całą
 * stronę: w przebiegu 2026-08-12 bloki obsłużyły KAŻDĄ stronę źródła (32 paczki, 340 bloków),
 * a obok stało 20 wywołań na całość po 264 789 znaków — co do jednego followupy.
 */
import { bdEnabled } from "../../adapters/brightdata.js";
import {
  type Fetched, type FetchedImage, fetchImageB64, fetchPlain, validators,
} from "../../adapters/page-fetch.js";
import { archiveRaw } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import { isFbFetch, urlKey } from "../../shared/url.js";
import { todayIso } from "../../shared/dates.js";
import type {
  CachedExtraction, EventItem, FollowupRun, PipelineError, PipelineState, Source, SourceRun,
} from "../../types/index.js";

import { harvestEventUrls, isEventUrl } from "../facebook.js";

import { detach } from "./block-cache.js";
import { blockSource } from "./block-source.js";
import { containerStats, dropUmbrellas, planProbes, probeContext } from "./container.js";
import { extractEvents, extractPoster } from "./extract.js";
import { followupsPerSource, rememberSameAsPage } from "./followup-queue.js";

/**
 * Klucz followupa w `state.extractions` — ZNORMALIZOWANY, nie surowy adres.
 *
 * `swarzedz.pl/x` i `www.swarzedz.pl/x` to jeden zasób, a dwa wpisy w cache'u znaczyły dwa
 * pobrania, dwa wywołania modelu i dwa komplety tych samych wydarzeń do rozstrzygnięcia
 * w dedupe. W state.json z 2026-08-12 stały tak cztery pary (swarzedz ×2, kornik, czerwonak).
 * To ta sama reguła, którą process-source.ts porównuje adresy (`isSameUrl`) — różnica
 * była zwykłym przeoczeniem, nie decyzją.
 */
export const followupKey = (url: string): string => urlKey(url);

/** Wydarzenia followupa — z cache po przetworzeniu (`processFollowup` zapisuje wynik do state). */
export const followupEvents = (url: string, state: PipelineState): EventItem[] =>
  detach(state.extractions?.[followupKey(url)]?.events ?? []);

/** Tyle, ile followup musi wiedzieć o źródle i o tym, co już przeczytała strona. */
export interface FollowupCtx {
  src: Source;
  state: PipelineState;
  errors: PipelineError[];
  /**
   * Hash treści STRONY ŹRÓDŁA z tego przebiegu. `undefined` = nie mamy czym porównać
   * (304 bez wpisu w cache'u), więc trzecia warstwa odsiewu po prostu milczy.
   */
  pageHash: string | undefined;
  /**
   * Tekst bloku, przy którym model wskazał ten odnośnik — dla plakatu uzupełnia rok i adres,
   * których grafika często nie niesie. `undefined` przy niezmienionej stronie: followupy
   * odtwarzamy wtedy ze `state`, gdzie leżą same adresy. To świadomie NIE jest powód, żeby
   * trzymać treść bloków w state.json — plakat pod niezmienioną stroną prawie zawsze siedzi
   * już w cache'u ekstrakcji i nie dochodzi do modelu w ogóle.
   */
  context?: string | undefined;
  /**
   * Zdanie o tym, czym ta PODSTRONA jest — jedzie do ekstrakcji TEKSTU, nie plakatu.
   * Powstaje wyłącznie w sondzie kontenerów (`probeContext`), bo tylko tam wiemy coś,
   * czego na stronie nie ma: zakres dat z karty, do której zajęcia z rytmem należą.
   * Osobne pole od `context`, żeby kontekst plakatu (surowy tekst bloku) nigdy nie trafił
   * do ekstrakcji strony — tam byłby zaproszeniem do przepisania cudzych wydarzeń.
   */
  program?: string | undefined;
}

/** Pobrana treść followupa albo `null`, gdy `fr` niesie już gotową odpowiedź (304 / błąd). */
interface Pulled {
  /** treść do zahashowania: tekst podstrony albo base64 plakatu */
  content: string;
  /** pełne pobranie — tylko dla podstron, bo tylko one idą ścieżką blokową */
  page: Fetched | null;
  img: Extract<FetchedImage, { notModified: false }> | null;
  validators: { etag?: string; lastModified?: string };
}

const validatorsOf = (v: { etag?: string; lastModified?: string }): Pulled["validators"] =>
  ({ ...(v.etag ? { etag: v.etag } : {}), ...(v.lastModified ? { lastModified: v.lastModified } : {}) });

/** Plakat, nie podstrona — rozstrzyga sam adres, więc pytamy o to w dwóch miejscach tak samo. */
const isPoster = (url: string): boolean => /\.(jpe?g|png)(\?|$)/i.test(url);

/** Warstwa 1: pobranie z walidatorami. `null` = nie ma czego czytać, `fr` już to mówi. */
async function pull(
  url: string, cached: CachedExtraction | undefined, fr: FollowupRun, archiveAs: string,
): Promise<Pulled | null> {
  if (isPoster(url)) {
    const got = await fetchImageB64(url, validators(cached));
    if (got === null) { fr.outcome = "error"; fr.err = "pobranie obrazu nieudane"; return null; }
    if (got.notModified) {
      fr.outcome = "unchanged";
      fr.events = cached?.events.length ?? 0;
      audit("followup", `plakat bez zmian (304) — ${fr.events} wydarzeń z cache`, { url });
      return null;
    }
    return { content: got.data, page: null, img: got, validators: validatorsOf(got) };
  }

  const sub = await fetchPlain(url, validators(cached));
  if (sub.kind === "not-modified") {
    fr.outcome = "unchanged";
    fr.events = cached?.events.length ?? 0;
    audit("followup", `podstrona bez zmian (304) — ${fr.events} wydarzeń z cache`, { url });
    return null;
  }
  await archiveRaw(archiveAs, url, sub.text, sub.kind);
  return { content: sub.text, page: sub, img: null, validators: validatorsOf(sub) };
}

interface ReadCtx {
  state: PipelineState;
  fr: FollowupRun;
  /** kontekst PLAKATU — surowy tekst bloku, przy którym stała grafika */
  context?: string;
  /** kontekst PROGRAMU — zdanie o podstronie; idzie wyłącznie do ekstrakcji tekstu */
  program?: string;
}

/**
 * Odczytanie treści followupa. Plakat idzie do modelu wzrokowego, podstrona — ścieżką blokową,
 * a gdy ta odmówi (za mało bloków, przebudowa serwisu), jednym wywołaniem na całość, jak dawniej.
 *
 * Rozliczenie podziału ląduje w `fr.blocks`, a nie w `SourceRun.blocks`: jedno źródło ma jedną
 * stronę i kilka followupów, więc wspólne pole zamazywałoby rozliczenie strony.
 */
async function read(url: string, got: Pulled, ctx: ReadCtx): Promise<EventItem[]> {
  const { state, fr, context, program } = ctx;
  if (got.img) {
    return (await extractPoster(
      { data: got.img.data, mediaType: got.img.mediaType, src: url }, url, context,
    )).events;
  }
  const viaBlocks = got.page && await blockSource(got.page, url, state, program);
  if (!viaBlocks) return (await extractEvents(got.content, url, program)).events;
  fr.blocks = viaBlocks.blocks;
  if (viaBlocks.note) fr.note = viaBlocks.note;
  return viaBlocks.events;
}

/**
 * Pobiera followup (podstrona / PDF / plakat) i zwraca jego wydarzenia.
 * Treść identyczna — na którykolwiek z trzech sposobów z nagłówka — nie kosztuje wywołania LLM.
 */
export async function processFollowup(url: string, ctx: FollowupCtx): Promise<FollowupRun> {
  const { src, state, errors, pageHash, context, program } = ctx;
  const fr: FollowupRun = { url, kind: isPoster(url) ? "poster" : "page", outcome: "ok", events: 0 };
  const cache = (state.extractions ??= {});
  const key = followupKey(url);
  const cached = cache[key];

  try {
    const got = await pull(url, cached, fr, `${src.id}__followup`);
    if (!got) return fr;

    // warstwa 2: serwer nie obsłużył warunkowego GET-a — porównujemy hash treści
    const hash = sha256(got.content);
    if (cached?.hash === hash) {
      cache[key] = { ...cached, ...got.validators, at: new Date().toISOString() };
      fr.outcome = "unchanged";
      fr.events = cached.events.length;
      audit("followup", `ten sam hash treści — ${fr.events} wydarzeń z cache, bez modelu`, { url });
      return fr;
    }

    // warstwa 3: TEN SAM ZASÓB POD DWOMA ADRESAMI. Wejście z etapu 1 dokłada się do korzenia
    // serwisu i bardzo często JEST korzeniem. `isSameUrl` tego nie łapie, bo adresy naprawdę
    // się różnią — równa jest dopiero treść. Bez tego płaciliśmy drugi raz za bajty przeczytane
    // przed chwilą, a wynik wracał jako komplet duplikatów źródła samego ze sobą (w przebiegu
    // 2026-08-12 dziesięć linii `dedupe.dropped` z `winner: mosina-pl-wydarzenia`).
    //
    // Wpis z cache'a KASUJEMY: trzymał drugą kopię wydarzeń strony i to on je tam wnosił.
    if (pageHash !== undefined && hash === pageHash) {
      delete cache[key];
      // werdykt ZAPAMIĘTANY: wykryć go da się dopiero tutaj, czyli po zużyciu slotu, więc bez
      // zapisu ten sam adres jadłby limit tego źródła w każdym kolejnym przebiegu
      rememberSameAsPage(url, src.id, state, todayIso());
      fr.outcome = "same-as-page";
      audit("followup",
        "treść identyczna ze stroną źródła — pomijamy, jej wydarzenia już są w sumie", { url });
      return fr;
    }

    const added = await read(url, got, {
      state, fr, ...(context ? { context } : {}), ...(program ? { program } : {}),
    });
    // cache po haszu CAŁEJ podstrony zostaje obok blokowego — z tego samego powodu, co przy
    // stronie źródła: gdy jutro wróci bajt w bajt taka sama, nie ma po co jej nawet dzielić
    cache[key] = { hash, events: detach(added), at: new Date().toISOString(), ...got.validators };
    fr.events = added.length;
    audit("followup", `${fr.kind === "poster" ? "plakat" : "podstrona"} → ${added.length} wydarzeń`, { url });
    return fr;
  } catch (e) {
    const err = describeError(e);
    errors.push({ id: src.id, followup: url, err });
    fr.outcome = "error";
    fr.err = err;
    audit("followup", `nieudany: ${err}`, { url });
    return fr;
  }
}

/** Tyle, ile pętla followupów musi wiedzieć o źródle i o przebiegu, który właśnie rozlicza. */
export interface FollowupsCtx {
  src: Source;
  state: PipelineState;
  errors: PipelineError[];
  /** raport źródła — pętla dopisuje do niego `followups` i rozliczenie sondy kontenerów */
  run: SourceRun;
  pageHash: string | undefined;
  /** followup → tekst bloku, przy którym model go wskazał (wejście do odczytu plakatu) */
  context: Map<string, string>;
  /** linki facebook.com/events/… do zbiorczego rozwiązania na końcu przebiegu */
  fbEventUrls: Set<string>;
}

/**
 * Pobranie jednego followupa i dołożenie jego wydarzeń; wynik ląduje w `run.followups`.
 * `program` podaje wyłącznie sonda kontenerów — followupy z propozycji modelu dostają
 * co najwyżej kontekst plakatu, tak jak dotąd.
 */
async function pullOne(
  url: string, into: EventItem[], ctx: FollowupsCtx, program?: string,
): Promise<FollowupRun> {
  const { src, state, errors, run, pageHash, context } = ctx;
  const blockText = context.get(url);
  const fr = await processFollowup(url, {
    src, state, errors, pageHash,
    ...(blockText ? { context: blockText } : {}),
    ...(program ? { program } : {}),
  });
  run.followups.push(fr);
  // „same-as-page" NIE wnosi wydarzeń: to te same bajty, co strona, a jej wydarzenia stoją już
  // w sumie. Dorzucenie ich tutaj byłoby dokładnie tym duplikatem, dla którego ten przypadek
  // w ogóle wykrywamy.
  if (fr.outcome === "ok" || fr.outcome === "unchanged") into.push(...followupEvents(url, state));
  return fr;
}

/**
 * SONDA KONTENERÓW — followupy, których nikt nam nie wskazał.
 *
 * Adresy biorą się z KSZTAŁTU wydarzeń, które już mamy (patrz container.ts), a nie z propozycji
 * modelu, więc mają własny sufit: propozycja modelu jest sygnałem z treści i nie ma prawa
 * przegrać z naszym domysłem. Sonda chodzi też przy NIEZMIENIONEJ stronie — parasol siedzący
 * w rejestrze od tygodnia ma się rozwiązać sam, bez czekania, aż serwis coś u siebie ruszy.
 */
async function probeContainers(collected: EventItem[], taken: string[], ctx: FollowupsCtx):
Promise<EventItem[]> {
  const { src, state, run } = ctx;
  // FB nie chodzi HTTP-em (Bright Data albo nic), więc sonda pod fanpage'em byłaby wyłącznie
  // pewnym błędem pobrania dopisanym do raportu
  if (isFbFetch(src.fetch)) return collected;
  const plan = planProbes(collected, { pageUrl: run.url, state, taken });
  if (!plan.suspects) return collected;

  const before = collected.length;
  for (const probe of plan.probes) {
    audit("container", `„${probe.title}" rozciąga się na ${probe.days} dni bez rytmu i bez godziny `
      + `— to wygląda na stronę programu, więc czytamy ją z zakresem ${probe.from}–${probe.to}`,
    { url: probe.url, days: probe.days, title: probe.title });
    // zakres z karty jedzie RAZEM z treścią: bez niego strona programu opisuje zajęcia samym
    // rytmem, model nie ma z czego zbudować `date_start` i słusznie nie oddaje ani jednego
    await pullOne(probe.url, collected, ctx, probeContext(probe));
  }

  const { kept, dropped } = dropUmbrellas(collected, plan.probes.map((p) => p.url));
  for (const u of dropped) {
    audit("container", `„${u.ev.title}" znika — pod jego adresem stoi ${u.children} wydarzeń `
      + "z konkretnymi terminami, a on sam był tylko parasolem",
    { url: u.url, children: u.children, title: u.ev.title });
  }
  run.containers = containerStats(plan, dropped, collected.length - before);
  return kept;
}

/**
 * Followupy źródła: propozycje modelu i wejście z etapu 1, a za nimi sonda kontenerów.
 *
 * Stoi TUTAJ, a nie w process-source.ts, z dwóch powodów naraz: pętla i sonda dzielą całą
 * obsługę jednego adresu (`pullOne`), a orkiestrator źródła jest na styku limitu rozmiaru
 * i każda kolejna reguła dopisana w nim wprost zabiera miejsce następnej.
 */
export async function runFollowups(
  urls: string[], pageEvents: EventItem[], ctx: FollowupsCtx,
): Promise<EventItem[]> {
  const collected: EventItem[] = [...pageEvents];
  const taken = urls.slice(0, followupsPerSource());
  for (const url of taken) {
    if (isEventUrl(url)) {
      // wydarzenia FB nie do pobrania HTTP-em — dołączają do zbiorczego rozwiązania przez Bright Data
      if (bdEnabled()) for (const u of harvestEventUrls(url)) ctx.fbEventUrls.add(u);
      continue;
    }
    await pullOne(url, collected, ctx);
  }
  return probeContainers(collected, taken, ctx);
}
