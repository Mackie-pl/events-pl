/**
 * Przetworzenie jednego źródła: pobranie → (cache?) → ekstrakcja → followupy → geokodowanie.
 *
 * Parowanie resetUsage()/snapshotUsage() i beginSource()/sourcePaths() MUSI zostać w tej
 * funkcji: oba liczniki są modułowe i wyznaczają granicę „jednego źródła". Przeniesienie
 * któregokolwiek do helpera przypisuje koszt tokenów niewłaściwemu źródłu — czego tsc nie
 * widzi, a co wychodzi dopiero jako błędny costs.json.
 */
import {
  BD_DATASETS, bdDelta, bdEnabled, bdSnapshot, bdUsage, collect as bdCollect,
} from "../../adapters/brightdata.js";
import { geocode } from "../../adapters/nominatim.js";
import { resetUsage, snapshotTasks, snapshotUsage } from "../../adapters/openrouter.js";
import { type Fetched, fetchHeadless, fetchPlain, validators } from "../../adapters/page-fetch.js";
import { archiveRaw, beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import { todayIso } from "../../shared/dates.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import { urlKey } from "../../shared/url.js";
import type {
  EventItem, EventOrigin, PipelineError, PipelineState, Source, SourceRun,
} from "../../types/index.js";
import {
  fbGroupPostsToBlocks, fbGroupPostsToText, fbGroupStats, fbImagePosts, fbOriginsByPost,
  fbPostExtras, fbShareStats, harvestEventUrls,
} from "../facebook.js";
import { dropRepertoire, repertoireSegment } from "../repertoire.js";
import { expandRepeat } from "../series.js";

import { detach, dropPast } from "./block-cache.js";
import { blockSource } from "./block-source.js";
import { fixCalendarDates } from "./calendar-links.js";
import { capabilitySource } from "./capability-source.js";
import { entryUrl } from "./entry-url.js";
import { noteFbGroup } from "./fb-group-blocked.js";
import { fetchFbPage } from "./fb-page.js";
import { auditFbGroup, auditFbOrigins, auditFbPostExtras, auditFbShares } from "./fb-group-trail.js";
import { fbGroupLimit, noteFbGroupRate } from "./fb-group-limit.js";
import { auditFbPosterYield, fbPosterYield } from "./fb-poster-yield.js";
import { MAX_FOLLOWUPS_PER_SOURCE, runFollowups } from "./followup.js";
import { droppedInvalidStats, extractEvents, resetDroppedInvalid } from "./extract.js";

/** Ten sam adres wg reguł rejestru (bez schematu, `www.`, końcowego `/`). */
const isSameUrl = (a: string, b: string): boolean => urlKey(a) === urlKey(b);

/**
 * Adresy do pobrania bez repertuarów. IDEMPOTENTNA i to jest tu warunek, nie ozdoba:
 * wołamy ją dwa razy — raz na propozycjach modelu (żeby limit MAX_FOLLOWUPS_PER_SOURCE
 * nie poszedł na adresy, których i tak nie pobierzemy), raz na gotowej liście (żeby złapać
 * także tę odtworzoną ze `state.followupsBySource` przy niezmienionej stronie). Drugie
 * wywołanie nie ma już czego odrzucić, więc nie dopisuje drugiej notki do śladu.
 */
function fetchable(urls: string[]): string[] {
  return urls.filter((u) => {
    const segment = repertoireSegment(u);
    if (!segment) return true;
    audit("url.skipped",
      `„/${segment}/" to repertuar, a nie lista wydarzeń — nie pobieramy tej podstrony`,
      { url: u, segment });
    return false;
  });
}

/**
 * Post w grupie FB → oryginał, którego jest udostępnieniem. Wypełniane przez `fetchSource`,
 * czytane przy dopisywaniu pól do wydarzeń; puste dla wszystkich innych rodzajów źródeł.
 */
let fbOrigins = new Map<string, EventOrigin>();

/**
 * Post w grupie FB → ile obrazów niósł rekord. Ta sama granica i ten sam powód co wyżej:
 * rekordy istnieją tylko w `fetchSource`, a pomiar plakatów powstaje dopiero na końcu,
 * gdy wiadomo, co model z tych postów wyciągnął. Pusta mapa dla wszystkiego, co nie
 * jest grupą — i wtedy `auditFbPosterYield` milczy zamiast raportować zera.
 */
let fbImages = new Map<string, number>();

export function newSourceRun(src: Source, url: string, status: SourceRun["status"]): SourceRun {
  return {
    id: src.id, name: src.name, town: src.town, url, fetch: src.fetch,
    status, events: 0, followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
  };
}


/** Fetch wg strategii źródła; 403/429 przy zwykłym fetchu to zwykle anty-bot — jedna próba przez headless. */
async function fetchSource(
  src: Source, url: string, run: SourceRun,
  opts: { state: PipelineState; headers: Record<string, string> },
): Promise<Fetched> {
  const { state, headers } = opts;
  if (src.fetch === "fb") {
    // fanpage: inny dataset Bright Data niż grupa, reszta ścieżki identyczna — o tym, czy
    // w ogóle tu wchodzi, decyduje regulator budżetu (fb-cost-mute.ts), nie ta gałąź
    const { fetched, origins } = await fetchFbPage(src, url, run);
    fbOrigins = origins;
    return fetched;
  }
  if (src.fetch === "fb_group") {
    // posty otwartej grupy przez Bright Data (FB blokuje zwykły fetch); BD zawsze zwraca
    // pełną treść — brak 304, diff załatwia standardowe porównanie hashy w processSource.
    // Limit jest liczony per grupa (regulator pokrycia, sufit = dotychczasowa stała 50):
    // bez limitu BD scrapuje całą historię — jedna grupa wisiała ~10h i wygenerowała
    // 729 rekordów, zanim nasz timeout i tak porzucił wynik ($8+ za nic).
    const limit = fbGroupLimit(src.id, state, todayIso());
    try {
      const records = await bdCollect(BD_DATASETS.fbGroupPosts, [url], limit);
      /**
       * Surowa migawka PRZED spłaszczeniem. Do modelu (i do archiwum jako `raw/`) idzie sam
       * tekst postów, więc wszystko, czego spłaszczanie nie bierze — pola obrazów, miejsca,
       * daty, wiersze błędu scrapera — istniało dotąd wyłącznie jako liczba w statystykach.
       * Osobne id (`__bd`), bo inaczej dwa różne zrzuty tego samego źródła leżą w archiwum
       * obok siebie i rozróżnia je dopiero otwarcie; ten sam wzór ma już `__followup`.
       */
      const bdRaw = await archiveRaw(
        `${src.id}__bd`, url, JSON.stringify(records, null, 1), "fb_group",
      );
      // pomiar PRZED spłaszczeniem do tekstu: daty postów są w rekordach, a w tekście dla
      // modelu już tylko jako napis, z którego nikt ich nie policzy
      run.fbGroup = fbGroupStats(records, limit);
      auditFbGroup(run.fbGroup, bdRaw);
      // też PRZED spłaszczeniem: obrazy i miejsca giną w nim bezpowrotnie
      auditFbPostExtras(fbPostExtras(records), run.fbGroup.posts);
      // stan modułowy jak liczniki zużycia — granicę „jednego źródła" wyznacza processSource,
      // które zeruje mapę na wejściu. Wydarzenia wracają z modelu bez rekordów, a wiązać je
      // z oryginałem trzeba adresem postu, który jest tylko tutaj
      fbOrigins = fbOriginsByPost(records);
      auditFbOrigins(fbOrigins.size, run.fbGroup.posts);
      // przynależność obrazów do POSTÓW (nie sumy — te są wyżej): zestawienie z wydarzeniami
      // zachodzi po ekstrakcji, a wtedy rekordów już nie ma
      fbImages = fbImagePosts(records);
      // ile z udostępnień to wklejone ogłoszenie, czyli ta sama treść po obu stronach postu —
      // liczone na rekordach, bo w spłaszczonym tekście jedna z kopii już nie istnieje
      auditFbShares(fbShareStats(records));
      // bloki DANE, nie zgadywane: granica postu przyszła w rekordzie, a `segment()`
      // odtwarzałby ją hashem akapitu — myląc się dla 40% postów (patrz fbGroupPostsToBlocks).
      // Separator zna wyłącznie facebook.ts, więc `text` bierzemy stamtąd, a nie sklejamy tutaj
      return {
        kind: "html",
        text: fbGroupPostsToText(records),
        blocks: fbGroupPostsToBlocks(records),
        httpStatus: 200,
      };
    } catch (e) {
      bdUsage.errors += 1;
      throw e;
    }
  }
  if (src.fetch === "headless") return fetchHeadless(url);
  try {
    return await fetchPlain(url, headers);
  } catch (e) {
    const hs = (e as { httpStatus?: number }).httpStatus;
    if (hs !== 403 && hs !== 429) throw e;
    try {
      const f = await fetchHeadless(url);
      run.note = `HTTP ${hs} → headless fallback ok`;
      audit("fetch.fallback", `HTTP ${hs} wygląda na anty-bota — druga próba przez przeglądarkę: udana`);
      return f;
    } catch {
      audit("fetch.fallback", `HTTP ${hs} — próba przez przeglądarkę też nieudana`);
      throw e; // brak playwrighta albo blokada również dla przeglądarki — raportuj pierwotny błąd
    }
  }
}

/**
 * DATY USTALANE „DZIŚ" — jedno przewężenie dla OBU ścieżek, maszynowej i modelowej.
 *
 * Każdy cache w tym potoku oddaje wydarzenia ocenione „dziś" sprzed wielu dni: blok czytany
 * tydzień temu, feed odtworzony z niezmienionej treści, plakat spod tego samego adresu.
 * Dlatego nic, co zależy od dzisiejszej daty, nie może stać przy ŹRÓDLE wydarzeń — tylko tu,
 * przy wyjściu z `processSource`. Inaczej każda nowa ścieżka musiałaby pamiętać, żeby to
 * powtórzyć, a zapomniały już dwie:
 *
 *  - `capabilitySource` wracał prosto do `finalize`, z pominięciem odsiewu minionych.
 *    W events.json dało to 62 wydarzenia minione JUŻ W DNIU PUBLIKACJI, połowa z tej ścieżki.
 *  - `expandRepeat` siedziało w `extractEvents`, czyli PRZED zapisem do cache'a, więc cache
 *    trzymał terminy policzone względem dnia pierwszej ekstrakcji. Odtworzenie z cache'a
 *    dokładało wtedy po jednym duplikacie na przebieg (patrz block-cache.ts, `detach`).
 *
 * Kolejność w środku jest wymuszona: najpierw rozwinięcie rytmu, potem odsiew. Odwrotnie
 * odsiew oglądałby zakres rytmu („do 12.08") zamiast jego terminów i przepuszczał wpisy,
 * których wszystkie terminy już minęły.
 */
function settleDates(events: EventItem[], run: SourceRun): EventItem[] {
  const past = dropPast(expandRepeat(events));
  if (past.dropped) {
    audit("event.past", `${past.dropped} wydarzeń już się odbyło — nie idą do scalania`,
      { dropped: past.dropped, kept: past.kept.length });
    run.droppedPast = past.dropped;
  }
  // Domknięcie reguły o repertuarze, w tym samym przewężeniu, co odsiew minionych i z tego
  // samego powodu: odrzucanie ADRESÓW działa przed pobraniem, ale seans potrafi przyjść wpisem
  // z listy głównej podpisanym linkiem do karty seansu — a wtedy nie ma już żadnego adresu
  // do odrzucenia. Licznik odpowiada, czy takie przecieki w ogóle istnieją.
  const rep = dropRepertoire(past.kept);
  if (rep.dropped) {
    audit("event.dropped",
      `${rep.dropped} wpisów wskazuje na kartę repertuaru — to seanse, nie wydarzenia`,
      { dropped: rep.dropped, kept: rep.kept.length });
    run.droppedRepertoire = rep.dropped;
  }
  return rep.kept;
}

/**
 * Domknięcie wydarzeń: przypisanie źródła i geokodowanie. Wspólne dla obu ścieżek —
 * maszynowej i modelowej — bo miejsce trzeba znaleźć tak samo niezależnie od tego,
 * czy termin przyszedł z `tribe`, czy z odczytania strony przez model.
 *
 * Krok na MIEJSCE, nie na wydarzenie: dziesięć wydarzeń w tej samej sali to jedno
 * pytanie do geokodera i jedna informacja dla czytającego ślad.
 */
async function attachGeo(
  events: EventItem[], src: Source, state: PipelineState, run: SourceRun,
): Promise<void> {
  const geoSeen = new Set<string>();
  for (const ev of events) {
    ev.source_id = src.id;
    ev.town ??= src.town;
    // TU, a nie przy ekstrakcji: to jedyna pętla po WSZYSTKICH wydarzeniach źródła — także
    // tych z cache'a bloków i z followupów, które o rekordach Bright Data nic nie wiedzą.
    // `urlKey` po OBU stronach mapy — inaczej rozjazd o `www.` cicho gubi całe wiązanie
    const origin = fbOrigins.get(urlKey(ev.source_url ?? ""));
    if (origin) ev.origin = origin;
    // geocode ma własny cache po "venue|town", więc wydarzenia z cache nie kosztują zapytań
    if (ev.venue) {
      const g = await geocode(ev.venue, ev.town, state.geo);
      ev.geo = g;
      if (g) run.geo.hits++; else run.geo.misses++;
      const key = `${ev.venue}|${ev.town}`;
      if (!geoSeen.has(key)) {
        geoSeen.add(key);
        audit("geo", g ? `„${ev.venue}" → ${g.lat}, ${g.lon}` : `„${ev.venue}" — geokoder nie zna tego adresu`,
          { venue: ev.venue, town: ev.town, hit: g !== null });
      }
    }
  }
}

export async function processSource(
  src: Source, state: PipelineState, errors: PipelineError[], fbEventUrls: Set<string>,
): Promise<{ events: EventItem[]; run: SourceRun }> {
  const t0 = performance.now();
  resetUsage();
  resetDroppedInvalid();
  fbOrigins = new Map();
  fbImages = new Map();
  beginSource(src.id);
  const bdBefore = bdSnapshot();
  const url = src.url.replace("{page}", "1");
  const run = newSourceRun(src, url, "empty");
  const finalize = (events: EventItem[]): { events: EventItem[]; run: SourceRun } => {
    run.events = events.length;
    const dropped = droppedInvalidStats();
    if (dropped) run.droppedInvalid = dropped;
    run.llm = snapshotUsage();
    const tasks = snapshotTasks();
    if (Object.keys(tasks).length) run.llmByTask = tasks;
    // grupa FB: rekordy Bright Data przypisane właśnie temu źródłu (rozliczenie per-rekord)
    const bd = bdDelta(bdBefore);
    if (bd) run.bd = bd;
    run.ms = Math.round(performance.now() - t0);
    // ścieżki do prywatnego archiwum — bez nich panel nie ma jak dotrzeć do treści
    const paths = sourcePaths();
    if (paths.length) run.archive = paths;
    return { events, run };
  };

  // --- ścieżka maszynowa: gotowe rekordy zamiast strony i modelu ---
  // null = źródło nie ma zdolności, feed nie odpowiedział albo nic nie dał; wtedy lecimy
  // dalej normalnie. Powód zejścia zostaje w śladzie jako `capability.fallback`.
  const viaCapability = await capabilitySource(src, state, run);
  if (viaCapability) {
    // przez to samo przewężenie, co ścieżka modelowa: `from-capability.ts` odrzuca minione przy
    // MAPOWANIU, ale wynik odtworzony z cache'a był mapowany innego dnia i zdążył się zestarzeć
    const events = settleDates(viaCapability, run);
    await attachGeo(events, src, state, run);
    run.status = events.length > 0 ? (run.changed === false ? "unchanged" : "ok") : "empty";
    audit("done",
      `status „${run.status}" — ${events.length} wydarzeń idzie do scalania `
      + "(ścieżka maszynowa, zero wywołań modelu)",
      { status: run.status, events: events.length, ms: Math.round(performance.now() - t0) });
    return finalize(events);
  }

  const cache = (state.extractions ??= {});
  const cached = cache[src.id];

  let fetched: Fetched;
  try {
    fetched = await fetchSource(src, url, run, { state, headers: validators(cached) });
  } catch (e) {
    const err = describeError(e);
    errors.push({ id: src.id, err });
    run.status = "error";
    run.err = err;
    const hs = (e as { httpStatus?: number }).httpStatus;
    if (typeof hs === "number") run.httpStatus = hs;
    audit("fetch", `pobranie nieudane: ${err}`, { url, strategy: src.fetch, httpStatus: hs });
    audit("done", "źródło bez wydarzeń — błąd pobrania");
    return finalize([]);
  }
  run.httpStatus = fetched.httpStatus;
  // dopiero po udanym pobraniu: rzucony fetch (timeout, 401, anulowana migawka) nie jest
  // dowodem NA GRUPĘ, tylko na Bright Data — karanie za niego wyłączałoby zdrowe grupy
  // grupy i fanpage'e jednakowo: obie księgi (blokady i regulator limitu) są adresowane id
  // źródła, a regulator liczy z POKRYCIA — czy okno sięgnęło wstecz do poprzedniego pobrania.
  // To pytanie ma sens dla każdego strumienia postów, niezależnie od tego, czyich
  if (run.fbGroup && (src.fetch === "fb_group" || src.fetch === "fb")) {
    noteFbGroup(src.id, run.fbGroup, state, todayIso());
    noteFbGroupRate(src.id, run.fbGroup, state, todayIso());
  }
  audit("fetch", `pobrane strategią „${src.fetch}" — HTTP ${fetched.httpStatus ?? "—"}`, {
    url, strategy: src.fetch, httpStatus: fetched.httpStatus,
  });

  // TU, przed hashem i podziałem na bloki, a nie przy wywołaniu modelu: gdyby poprawka szła
  // dopiero do promptu, hash treści i hashe bloków zostałyby stare, cache trafiłby i oddał
  // wydarzenia z fałszywą godziną — poprawka zadziałałaby dopiero, gdy serwis sam się zmieni.
  // Kosztem jest jednorazowe przeczytanie tych źródeł od nowa (jak przy kodowaniu, TODO 7).
  if (fetched.kind !== "not-modified") {
    const cal = fixCalendarDates(fetched.text);
    if (cal.fixed) {
      fetched = { ...fetched, text: cal.text };
      audit("content",
        `${cal.fixed}× widget „dodaj do kalendarza" z godziną początku równą końcowi — `
        + "zdjęta część godzinowa, bo to wpis całodniowy zapisany źle",
        { fixedCalendarDates: cal.fixed });
    }
  }

  // --- strona źródła: 304 albo ten sam hash => wydarzenia z cache, bez wywołania LLM ---
  let pageEvents: EventItem[];
  let followupUrls: string[];
  /**
   * Followup → tekst bloku, przy którym model go wskazał. Pusta, gdy strona się nie zmieniła
   * (odtwarzamy wtedy same adresy ze `state`) albo gdy ścieżka blokowa odmówiła — i to jest
   * w porządku: plakat bez kontekstu czyta się tak, jak czytał się dotąd.
   */
  let followupContext = new Map<string, string>();
  /**
   * Hash treści strony źródła — do porównania z followupami (patrz `processFollowup`).
   * Przy 304 bierzemy go z cache'u: treści nie mamy, ale to nadal hash TEJ SAMEJ treści,
   * którą serwer właśnie potwierdził jako niezmienioną.
   */
  let pageHash: string | undefined;

  if (fetched.kind === "not-modified" && cached) {
    run.changed = false;
    run.kind = "html";
    pageHash = cached.hash;
    pageEvents = detach(cached.events);
    followupUrls = state.followupsBySource?.[src.id] ?? [];
    audit("content", "HTTP 304 — serwer potwierdził brak zmian, treści w ogóle nie pobieraliśmy");
    audit("cache.hit", `${pageEvents.length} wydarzeń z cache (ekstrakcja z ${cached.at.slice(0, 10)})`,
      { events: pageEvents.length, since: cached.at });
    // 304 = brak treści do przeszukania — linki do wydarzeń FB wracają ze stanu
    if (bdEnabled()) for (const u of state.fbUrlsBySource?.[src.id] ?? []) fbEventUrls.add(u);
  } else {
    run.kind = fetched.kind === "pdf" ? "pdf" : "html";
    run.chars = fetched.text.length;
    await archiveRaw(src.id, url, fetched.text, fetched.kind);
    if (!fetched.text.trim()) {
      run.status = "empty";
      audit("content", "pobrana treść jest pusta — nie ma czego dawać modelowi");
      audit("done", "źródło bez wydarzeń — pusta treść");
      return finalize([]);
    }

    // linki facebook.com/events/… w treści — rozwiązywane zbiorczo na końcu przebiegu
    if (bdEnabled()) {
      const found = harvestEventUrls(fetched.text);
      (state.fbUrlsBySource ??= {})[src.id] = found;
      for (const u of found) fbEventUrls.add(u);
      if (found.length) {
        audit("fb.harvest", `${found.length} linków do wydarzeń FB — do zbiorczego rozwiązania`,
          { urls: found.length });
      }
    }

    const hash = sha256(fetched.text);
    pageHash = hash;
    const v = {
      ...(fetched.etag ? { etag: fetched.etag } : {}),
      ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
    };

    if (cached?.hash === hash) {
      // treść bez zmian — odświeżamy tylko walidatory, wydarzenia zostają
      cache[src.id] = { ...cached, ...v, at: new Date().toISOString() };
      run.changed = false;
      pageEvents = detach(cached.events);
      followupUrls = state.followupsBySource?.[src.id] ?? [];
      audit("content", `${fetched.text.length} znaków, ten sam hash co poprzednio — bez wywołania modelu`,
        { chars: fetched.text.length, hash: hash.slice(0, 12) });
      audit("cache.hit", `${pageEvents.length} wydarzeń z cache (ekstrakcja z ${cached.at.slice(0, 10)})`,
        { events: pageEvents.length, since: cached.at });
    } else {
      run.changed = true;
      audit("content", `${fetched.text.length} znaków, hash inny niż poprzednio — idzie do modelu`,
        { chars: fetched.text.length, hash: hash.slice(0, 12), was: cached?.hash.slice(0, 12) ?? null });

      // ścieżka blokowa: do modelu idą wyłącznie bloki, których jeszcze nie widzieliśmy.
      // `null` = odmówiła (brak struktury, przebudowa serwisu) i lecimy jak dawniej.
      const viaBlocks = await blockSource(fetched, url, state);
      let proposed: string[];
      if (viaBlocks) {
        pageEvents = viaBlocks.events;
        proposed = viaBlocks.followups;
        followupContext = viaBlocks.context;
        run.blocks = viaBlocks.blocks;
        if (viaBlocks.note) run.note = viaBlocks.note;
      } else {
        const result = await extractEvents(fetched.text, url);
        pageEvents = [...(result.events ?? [])];
        if (result.parse) {
          // do raportu, nie tylko do śladu: `--yield` liczy jałowe źródła z runs.json i bez tej
          // notatki „zepsuty odczyt" wygląda tam na „serwis nie ma wydarzeń"
          run.note = result.parse === "truncated"
            ? `odpowiedź modelu ucięta na limicie — odzyskano ${result.recovered ?? 0} wydarzeń`
            : `nie dało się odczytać odpowiedzi modelu (${result.parse})`;
        }
        proposed = (result.followups ?? []).map((f) => f.url);
      }
      // cache po haszu CAŁEJ strony zostaje obok blokowego: gdy jutro strona wróci bajt
      // w bajt taka sama, nie ma po co jej nawet dzielić
      cache[src.id] = { hash, events: detach(pageEvents), at: new Date().toISOString(), ...v };
      state.hashes[src.id] = hash; // legacy, dla zgodności ze starym state.json
      // odsiew PRZED limitem: repertuar w czołówce propozycji zabierałby miejsce podstronie,
      // którą naprawdę chcemy przeczytać
      followupUrls = fetchable(proposed).slice(0, MAX_FOLLOWUPS_PER_SOURCE);
      if (proposed.length) {
        // ucięcie ponad limit było dotąd niewidoczne: raport pokazywał tylko to, co pobrano
        audit("followup.proposed", proposed.length > followupUrls.length
          ? `model wskazał ${proposed.length} odnośników — bierzemy ${followupUrls.length}, limit na źródło`
          : `model wskazał ${followupUrls.length} odnośników do dociągnięcia`,
        { proposed: proposed.length, taken: followupUrls.length });
      }
      (state.followupsBySource ??= {})[src.id] = followupUrls;
    }
  }

  // lista odtworzona z cache'a (304 / ten sam hash) nie przeszła jeszcze przez odsiew: powstała,
  // zanim reguła o repertuarze istniała, a przy niezmienionej stronie nic jej nie odświeży
  followupUrls = fetchable(followupUrls);

  // --- wejście z etapu 1 dołącza do followupów ---
  // Etap 1 ustala, GDZIE serwis wypisuje wydarzenia, i do tej pory nikt tego nie czytał:
  // 26 z 41 pobieranych źródeł wchodziło korzeniem serwisu, a nie listą imprez.
  //
  // Wejście dokłada się do korzenia, a nie go zastępuje — bo pomiar (2026-08-01, sam fetch,
  // bez modelu) pokazał, że wymiana bywa STRATĄ: lubon.pl ma na stronie głównej 6 różnych dat,
  // a na `/artykuly/350/wydarzenia` zero; kultura.poznan.pl odpowiednio 5 i zero. Odwrotnie
  // niż w komorniki.pl (1 na korzeniu, 11 pod kalendarzem). Skoro raz jedno, raz drugie,
  // to wybór między nimi byłby zgadywaniem — a suma jest zawsze ≥ każdej ze stron z osobna.
  // Mechanizm followupów robi dokładnie to i ma już cache po hashu, więc powtórka nic nie kosztuje.
  const entry = entryUrl(src);
  for (const s of entry.skipped ?? []) {
    audit("url.skipped",
      `etap 1 wskazał „/${s.segment}/" jako listę wydarzeń — to repertuar, `
      + "więc wchodzimy korzeniem serwisu",
      { url: s.url, segment: s.segment });
  }
  if (entry.entrypoint && !isSameUrl(entry.url, url) && !followupUrls.some((u) => isSameUrl(u, entry.url))) {
    // na początek listy: limit MAX_FOLLOWUPS_PER_SOURCE nie może wypchnąć adresu,
    // o którym WIEMY, że stoją pod nim wydarzenia, na rzecz propozycji modelu
    followupUrls = [entry.url, ...followupUrls].slice(0, MAX_FOLLOWUPS_PER_SOURCE);
    audit("followup.proposed",
      `wejście z etapu 1 (${entry.entrypoint.kind}, ×${entry.entrypoint.detailCount ?? "?"} odnośników) ` +
      "dołącza do followupów",
      { url: entry.url, via: entry.entrypoint.via, confidence: entry.entrypoint.confidence });
  }

  // --- followupy: sprawdzane ZAWSZE, także gdy strona się nie zmieniła ---
  // plakat/PDF potrafi się zmienić pod tym samym URL-em przy nietkniętym tekście strony
  if (!run.changed && followupUrls.length) run.followupsRechecked = followupUrls.length;
  // pętla followupów razem z sondą kontenerów siedzi w followup.ts — patrz `runFollowups`
  const collected = await runFollowups(followupUrls, pageEvents, {
    src, state, errors, run, pageHash, context: followupContext, fbEventUrls,
  });

  const events = settleDates(collected, run);

  // po scaleniu wszystkich dróg (model, cache bloków, followupy), a przed geokoderem:
  // pomiar ma widzieć DOKŁADNIE te wydarzenia, które źródło oddaje dalej
  if (fbImages.size) {
    run.fbPoster = fbPosterYield(fbImages, events);
    auditFbPosterYield(run.fbPoster);
  }

  await attachGeo(events, src, state, run);

  const anyFollowupChanged = run.followups.some((f) => f.outcome === "ok");
  if (!run.changed && !anyFollowupChanged) {
    // nic się nie zmieniło — ale wydarzenia wracają z cache zamiast zniknąć z serwisu
    run.status = events.length > 0 ? "unchanged" : "empty";
    run.cached = events.length;
  } else {
    run.status = events.length > 0 ? "ok" : "empty";
    if (!run.changed) run.cached = pageEvents.length;
  }
  audit("done", `status „${run.status}" — ${events.length} wydarzeń idzie do scalania`,
    { status: run.status, events: events.length, ms: Math.round(performance.now() - t0) });
  return finalize(events);
}
