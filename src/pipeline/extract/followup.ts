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
import {
  type Fetched, type FetchedImage, fetchImageB64, fetchPlain, validators,
} from "../../adapters/page-fetch.js";
import { archiveRaw } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import { urlKey } from "../../shared/url.js";
import type {
  CachedExtraction, EventItem, FollowupRun, PipelineError, PipelineState, Source,
} from "../../types/index.js";

import { detach } from "./block-cache.js";
import { blockSource } from "./block-source.js";
import { extractEvents, extractPoster } from "./extract.js";

export const MAX_FOLLOWUPS_PER_SOURCE = 5;

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

/**
 * Odczytanie treści followupa. Plakat idzie do modelu wzrokowego, podstrona — ścieżką blokową,
 * a gdy ta odmówi (za mało bloków, przebudowa serwisu), jednym wywołaniem na całość, jak dawniej.
 *
 * Rozliczenie podziału ląduje w `fr.blocks`, a nie w `SourceRun.blocks`: jedno źródło ma jedną
 * stronę i do pięciu followupów, więc wspólne pole zamazywałoby rozliczenie strony.
 */
async function read(
  url: string, got: Pulled, ctx: { state: PipelineState; fr: FollowupRun; context?: string },
): Promise<EventItem[]> {
  const { state, fr, context } = ctx;
  if (got.img) {
    return (await extractPoster(
      { data: got.img.data, mediaType: got.img.mediaType }, url, context,
    )).events;
  }
  const viaBlocks = got.page && await blockSource(got.page, url, state);
  if (!viaBlocks) return (await extractEvents(got.content, url)).events;
  fr.blocks = viaBlocks.blocks;
  if (viaBlocks.note) fr.note = viaBlocks.note;
  return viaBlocks.events;
}

/**
 * Pobiera followup (podstrona / PDF / plakat) i zwraca jego wydarzenia.
 * Treść identyczna — na którykolwiek z trzech sposobów z nagłówka — nie kosztuje wywołania LLM.
 */
export async function processFollowup(url: string, ctx: FollowupCtx): Promise<FollowupRun> {
  const { src, state, errors, pageHash, context } = ctx;
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
      fr.outcome = "same-as-page";
      audit("followup",
        "treść identyczna ze stroną źródła — pomijamy, jej wydarzenia już są w sumie", { url });
      return fr;
    }

    const added = await read(url, got, { state, fr, ...(context ? { context } : {}) });
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
