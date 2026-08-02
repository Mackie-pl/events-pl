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
import {
  type Fetched, type FetchedImage, fetchImageB64, fetchHeadless, fetchPlain, validators,
} from "../../adapters/page-fetch.js";
import { archiveRaw, beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import { urlKey } from "../../shared/url.js";
import type {
  EventItem, FollowupRun, PipelineError, PipelineState, Source, SourceRun,
} from "../../types/index.js";
import { fbGroupPostsToText, harvestEventUrls, isEventUrl } from "../facebook.js";

import { capabilitySource } from "./capability-source.js";
import { entryUrl } from "./entry-url.js";
import {
  droppedInvalidStats, extractEvents, extractPoster, resetDroppedInvalid,
} from "./extract.js";

const MAX_FOLLOWUPS_PER_SOURCE = 5;

/** Ten sam adres wg reguł rejestru (bez schematu, `www.`, końcowego `/`). */
const isSameUrl = (a: string, b: string): boolean => urlKey(a) === urlKey(b);

export function newSourceRun(src: Source, url: string, status: SourceRun["status"]): SourceRun {
  return {
    id: src.id, name: src.name, town: src.town, url, fetch: src.fetch,
    status, events: 0, followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
  };
}

/** Fetch wg strategii źródła; 403/429 przy zwykłym fetchu to zwykle anty-bot — jedna próba przez headless. */
async function fetchSource(
  src: Source, url: string, run: SourceRun, extraHeaders: Record<string, string> = {},
): Promise<Fetched> {
  if (src.fetch === "fb_group") {
    // posty otwartej grupy przez Bright Data (FB blokuje zwykły fetch); BD zawsze zwraca
    // pełną treść — brak 304, diff załatwia standardowe porównanie hashy w processSource
    try {
      const records = await bdCollect(BD_DATASETS.fbGroupPosts, [url]);
      return { kind: "html", text: fbGroupPostsToText(records), httpStatus: 200 };
    } catch (e) {
      bdUsage.errors += 1;
      throw e;
    }
  }
  if (src.fetch === "headless") return fetchHeadless(url);
  try {
    return await fetchPlain(url, extraHeaders);
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
 * Pobiera followup (podstrona / PDF / plakat) i zwraca jego wydarzenia.
 * Treść identyczna (304 albo ten sam hash) → wydarzenia z cache, zero wywołań LLM.
 */
async function processFollowup(
  url: string, src: Source, state: PipelineState, errors: PipelineError[],
): Promise<FollowupRun> {
  const isImg = /\.(jpe?g|png)(\?|$)/i.test(url);
  const fr: FollowupRun = { url, kind: isImg ? "poster" : "page", outcome: "ok", events: 0 };
  const cache = (state.extractions ??= {});
  const cached = cache[url];

  try {
    let content: string | null = null;   // treść do zahashowania
    let img: Extract<FetchedImage, { notModified: false }> | null = null;
    let v: { etag?: string; lastModified?: string } = {};

    if (isImg) {
      const got = await fetchImageB64(url, validators(cached));
      if (got === null) { fr.outcome = "error"; fr.err = "pobranie obrazu nieudane"; return fr; }
      if (got.notModified) {
        fr.outcome = "unchanged";
        fr.events = cached?.events.length ?? 0;
        audit("followup", `plakat bez zmian (304) — ${fr.events} wydarzeń z cache`, { url });
        return fr;
      }
      img = got;
      content = got.data;
      v = { ...(got.etag ? { etag: got.etag } : {}), ...(got.lastModified ? { lastModified: got.lastModified } : {}) };
    } else {
      const sub = await fetchPlain(url, validators(cached));
      if (sub.kind === "not-modified") {
        fr.outcome = "unchanged";
        fr.events = cached?.events.length ?? 0;
        audit("followup", `podstrona bez zmian (304) — ${fr.events} wydarzeń z cache`, { url });
        return fr;
      }
      content = sub.text;
      v = { ...(sub.etag ? { etag: sub.etag } : {}), ...(sub.lastModified ? { lastModified: sub.lastModified } : {}) };
      await archiveRaw(`${src.id}__followup`, url, sub.text, sub.kind);
    }

    // serwer nie obsłużył warunkowego GET-a — porównujemy hash treści
    const hash = sha256(content);
    if (cached?.hash === hash) {
      cache[url] = { ...cached, ...v, at: new Date().toISOString() };
      fr.outcome = "unchanged";
      fr.events = cached.events.length;
      audit("followup", `ten sam hash treści — ${fr.events} wydarzeń z cache, bez modelu`, { url });
      return fr;
    }

    const added = img
      ? (await extractPoster({ data: img.data, mediaType: img.mediaType }, url)).events
      : (await extractEvents(content, url)).events;

    cache[url] = { hash, events: added, at: new Date().toISOString(), ...v };
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

/** Wydarzenia followupa — z cache po przetworzeniu (processFollowup zapisuje wynik do state). */
const followupEvents = (url: string, state: PipelineState): EventItem[] =>
  state.extractions?.[url]?.events ?? [];

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
    await attachGeo(viaCapability, src, state, run);
    run.status = viaCapability.length > 0 ? (run.changed === false ? "unchanged" : "ok") : "empty";
    audit("done",
      `status „${run.status}" — ${viaCapability.length} wydarzeń idzie do scalania `
      + "(ścieżka maszynowa, zero wywołań modelu)",
      { status: run.status, events: viaCapability.length, ms: Math.round(performance.now() - t0) });
    return finalize(viaCapability);
  }

  const cache = (state.extractions ??= {});
  const cached = cache[src.id];

  let fetched: Fetched;
  try {
    fetched = await fetchSource(src, url, run, validators(cached));
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
  audit("fetch", `pobrane strategią „${src.fetch}" — HTTP ${fetched.httpStatus ?? "—"}`, {
    url, strategy: src.fetch, httpStatus: fetched.httpStatus,
  });

  // --- strona źródła: 304 albo ten sam hash => wydarzenia z cache, bez wywołania LLM ---
  let pageEvents: EventItem[];
  let followupUrls: string[];

  if (fetched.kind === "not-modified" && cached) {
    run.changed = false;
    run.kind = "html";
    pageEvents = cached.events;
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
    const v = {
      ...(fetched.etag ? { etag: fetched.etag } : {}),
      ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
    };

    if (cached?.hash === hash) {
      // treść bez zmian — odświeżamy tylko walidatory, wydarzenia zostają
      cache[src.id] = { ...cached, ...v, at: new Date().toISOString() };
      run.changed = false;
      pageEvents = cached.events;
      followupUrls = state.followupsBySource?.[src.id] ?? [];
      audit("content", `${fetched.text.length} znaków, ten sam hash co poprzednio — bez wywołania modelu`,
        { chars: fetched.text.length, hash: hash.slice(0, 12) });
      audit("cache.hit", `${pageEvents.length} wydarzeń z cache (ekstrakcja z ${cached.at.slice(0, 10)})`,
        { events: pageEvents.length, since: cached.at });
    } else {
      run.changed = true;
      audit("content", `${fetched.text.length} znaków, hash inny niż poprzednio — idzie do modelu`,
        { chars: fetched.text.length, hash: hash.slice(0, 12), was: cached?.hash.slice(0, 12) ?? null });
      const result = await extractEvents(fetched.text, url);
      pageEvents = [...(result.events ?? [])];
      if (result.parse) {
        // do raportu, nie tylko do śladu: `--yield` liczy jałowe źródła z runs.json i bez tej
        // notatki „zepsuty odczyt" wygląda tam na „serwis nie ma wydarzeń"
        run.note = result.parse === "truncated"
          ? `odpowiedź modelu ucięta na limicie — odzyskano ${result.recovered ?? 0} wydarzeń`
          : `nie dało się odczytać odpowiedzi modelu (${result.parse})`;
      }
      cache[src.id] = { hash, events: pageEvents, at: new Date().toISOString(), ...v };
      state.hashes[src.id] = hash; // legacy, dla zgodności ze starym state.json
      const proposed = (result.followups ?? []).map((f) => f.url);
      followupUrls = proposed.slice(0, MAX_FOLLOWUPS_PER_SOURCE);
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
  const events: EventItem[] = [...pageEvents];
  for (const fuUrl of followupUrls.slice(0, MAX_FOLLOWUPS_PER_SOURCE)) {
    if (isEventUrl(fuUrl)) {
      // wydarzenia FB nie do pobrania HTTP-em — dołączają do zbiorczego rozwiązania przez Bright Data
      if (bdEnabled()) for (const u of harvestEventUrls(fuUrl)) fbEventUrls.add(u);
      continue;
    }
    const fr = await processFollowup(fuUrl, src, state, errors);
    run.followups.push(fr);
    if (fr.outcome !== "error") events.push(...followupEvents(fuUrl, state));
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
