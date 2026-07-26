/**
 * Stage 2: codzienny pipeline ekstrakcji wydarzeń.
 * sources.json -> fetch -> diff -> LLM (Haiku) -> expand followups (PDF/podstrony/plakaty)
 * -> geocode -> dedupe -> events.json -> index.html
 *
 * Uruchomienie: ANTHROPIC_API_KEY=... npm run daily
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { convert as htmlToText } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";

import {
  RETENTION_DAYS as ARCHIVE_RETENTION_DAYS, archiveEnabled, archiveEventsFull, archiveLlmCall,
  archiveRaw, archiveStats, beginRun, beginSource, sourcePaths,
} from "./archive.js";
import { BD_DATASETS, bdDelta, bdEnabled, bdSnapshot, bdUsage, collect as bdCollect } from "./brightdata.js";
import { type CostInput, costEntries, costLine, costRates, recordCosts } from "./cost.js";
import { BROWSER_HEADERS, describeError, fetchUrl } from "./errors.js";
import { fbEventToItem, fbGroupPostsToText, harvestEventUrls, isEventUrl } from "./facebook.js";
import { MODEL_EXTRACT, chat, imagePart, resetUsage, setCallRecorder, snapshotTasks, snapshotUsage } from "./llm.js";
import { type RedactionStats, redactEvents, redactText } from "./pii.js";
import { DEDUPE_SYSTEM, POSTER_SYSTEM, extractionSystem } from "./prompts.js";
import {
  BD_USAGE_LOG, EVENTS_PATH, INDEX_HTML, RUNS_PATH, SOURCES_PATH, STATE_PATH, TEMPLATE_HTML,
} from "./shared/paths.js";
import type {
  CachedExtraction, CostDriver, CostEntry, EventItem, EventsFile, ExtractionResult, FollowupRun,
  LlmTask, PipelineError, PipelineState, RunReport, RunTotals, Source, SourceRun, SourcesFile,
} from "./types/index.js";

/**
 * Ile historii przebiegów zostaje w publicznym repo. Dane są zredagowane (pii.ts),
 * więc ogranicza nas tylko rozmiar pliku: ~25 kB na przebieg × 1 przebieg/dzień.
 * Tydzień to okno, w którym „od kiedy to źródło zwraca zero?" da się jeszcze zamknąć
 * bez sięgania do historii gita. Trend kosztów żyje osobno w costs.json (90 dni),
 * bo jest o dwa rzędy wielkości mniejszy.
 */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_MIN_KEEP = 2; // zawsze zostaw min. tyle przebiegów, nawet po przerwie w cronie
/** Sufit na wypadek ręcznych przebiegów: 7 dni × kilka dziennie nie może rozdąć pliku. */
const RUN_MAX_KEEP = 30;
// Nominatim wymaga UA identyfikującego aplikację (usage policy) — tu zostaje bot.
const UA = { "User-Agent": "LocalEventsBot/0.3 (+kontakt: twoj@email)" };
const MAX_FOLLOWUPS_PER_SOURCE = 5;
const MAX_INPUT_CHARS = 40_000; // ~10k tokenów
// log zużycia Bright Data per przebieg (rozliczenie per-rekord) — commitowany, do liczenia kosztu
/** Górny limit rozwiązywanych linków do wydarzeń FB na przebieg — bezpiecznik kosztów Bright Data. */
const MAX_FB_EVENTS_PER_RUN = Number(process.env["BD_MAX_FB_EVENTS"] ?? 40);

// ---------------- fetch ----------------

/**
 * Wolumen sieciowy przebiegu. Pobrania i geokodowanie są dziś darmowe (GH Actions dla repo
 * publicznego, Nominatim), ale „darmowe" znaczy „zero do limitu" — bez zapisanego wolumenu
 * pierwszy rachunek za przekroczenie albo pierwszy ban od Nominatima są niespodzianką.
 * Liczy tylko żądania, które faktycznie poszły w sieć (304 też, cache — nie).
 */
const netUsage = { fetches: 0, geoLookups: 0 };

type Fetched = {
  kind: "html" | "pdf" | "skip" | "not-modified";
  text: string;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
};

/**
 * Nagłówki warunkowe z cache. Gdy serwer je obsługuje, odpowiada 304 i nie przesyła treści —
 * najtańszy możliwy sposób stwierdzenia, że plakat/PDF się nie zmienił.
 */
function validators(c?: CachedExtraction): Record<string, string> {
  const h: Record<string, string> = {};
  if (c?.etag) h["If-None-Match"] = c.etag;
  if (c?.lastModified) h["If-Modified-Since"] = c.lastModified;
  return h;
}

const validatorsOf = (res: Response): { etag?: string; lastModified?: string } => {
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
};

/** Błąd HTTP niosący kod statusu, żeby raport mógł go pokazać nawet przy porażce. */
function httpError(status: number, url: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${url}`), { httpStatus: status });
}

async function fetchPlain(url: string, extraHeaders: Record<string, string> = {}): Promise<Fetched> {
  netUsage.fetches += 1;
  const res = await fetchUrl(url, { headers: { ...BROWSER_HEADERS, ...extraHeaders } }, 30_000);
  if (res.status === 304) return { kind: "not-modified", text: "", httpStatus: 304 };
  if (!res.ok) throw httpError(res.status, url);
  const status = res.status;
  const v = validatorsOf(res);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    // unpdf nie eksportuje typu PDFDocumentProxy, więc dla tseslinta to „error type". tsc to
    // przepuszcza, bo extractText przyjmuje dokładnie to, co zwraca getDocumentProxy.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- brak typu w unpdf
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return { kind: "pdf", text, httpStatus: status, ...v };
  }
  const html = await res.text();
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "nav", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "footer", format: "skip" },
    ],
  });
  return { kind: "html", text, httpStatus: status, ...v };
}

async function fetchHeadless(url: string): Promise<Fetched> {
  // playwright jest optionalDependency — dynamiczny import przez zmienną,
  // żeby typecheck przechodził bez zainstalowanego pakietu
  interface MinimalResponse { status(): number }
  interface MinimalPage { goto(u: string, o: { waitUntil: string; timeout: number }): Promise<MinimalResponse | null>; content(): Promise<string> }
  interface MinimalBrowser { newPage(): Promise<MinimalPage>; close(): Promise<void> }
  const modName = "playwright";
  netUsage.fetches += 1;
  const { chromium } = (await import(modName)) as { chromium: { launch(): Promise<MinimalBrowser> } };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const status = resp?.status() ?? 0;
    if (status >= 400) throw httpError(status, url);
    const html = await page.content();
    return { kind: "html", text: htmlToText(html, { wordwrap: false }), httpStatus: status };
  } finally {
    await browser.close();
  }
}

type FetchedImage =
  | { notModified: true }
  | { notModified: false; data: string; mediaType: "image/jpeg" | "image/png"; etag?: string; lastModified?: string };

/** Plakat JPG/PNG -> base64 dla modelu wizyjnego. 304 = ten sam plakat, nie pobieramy bajtów. */
async function fetchImageB64(url: string, extraHeaders: Record<string, string> = {}): Promise<FetchedImage | null> {
  netUsage.fetches += 1;
  const res = await fetchUrl(url, { headers: { ...BROWSER_HEADERS, ...extraHeaders } }, 30_000);
  if (res.status === 304) return { notModified: true };
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 5_000_000) return null;
  return {
    notModified: false,
    data: buf.toString("base64"),
    mediaType: /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg",
    ...validatorsOf(res),
  };
}

// ---------------- LLM ----------------

function parseJson(s: string): ExtractionResult {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [] };
  try {
    return JSON.parse(m[0]) as ExtractionResult;
  } catch {
    return { events: [] };
  }
}

async function extractEvents(text: string, sourceUrl: string): Promise<ExtractionResult> {
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
    maxTokens: 4000,
  });
  return parseJson(out);
}

async function extractPoster(img: { data: string; mediaType: "image/jpeg" | "image/png" }, sourceUrl: string): Promise<ExtractionResult> {
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "poster",
    system: POSTER_SYSTEM,
    user: [imagePart(img.data, img.mediaType), { type: "text", text: `ŹRÓDŁO: ${sourceUrl}` }],
    maxTokens: 2000,
  });
  return parseJson(out);
}

// ---------------- geocoding (Nominatim, darmowe, 1 req/s) ----------------

async function geocode(venue: string, town: string, cache: PipelineState["geo"]): Promise<{ lat: number; lon: number } | null> {
  const key = `${venue}|${town}`;
  if (key in cache) return cache[key] ?? null;
  const q = town ? `${venue}, ${town}, Poland` : `${venue}, Poland`;
  netUsage.geoLookups += 1;
  try {
    const res = await fetchUrl(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "json", limit: "1" }).toString()}`,
      { headers: UA },
      15_000,
    );
    const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = hits[0];
    cache[key] = hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
  } catch (e) {
    console.warn(`geocode "${q}": ${describeError(e)}`);
    cache[key] = null;
  }
  await sleep(1_100); // polityka Nominatim
  return cache[key] ?? null;
}

// ---------------- dedupe ----------------

/** Tania heurystyka; LLM-owy dedupe (DEDUPE_SYSTEM) do podpięcia dla niejednoznacznych par. */
function dedupe(events: EventItem[]): EventItem[] {
  const seen = new Map<string, EventItem>();
  const out: EventItem[] = [];
  for (const ev of events) {
    const key = `${(ev.title ?? "").toLowerCase().replace(/\W+/g, "").slice(0, 40)}|${ev.date_start}`;
    const prev = seen.get(key);
    if (prev) {
      if (JSON.stringify(ev).length > JSON.stringify(prev).length) {
        out[out.indexOf(prev)] = ev; // zachowaj bogatszy rekord
        seen.set(key, ev);
      }
      continue;
    }
    seen.set(key, ev);
    out.push(ev);
  }
  return out;
}
void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO

// ---------------- main ----------------

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf-8")) as T) : fallback;
}

function newSourceRun(src: Source, url: string, status: SourceRun["status"]): SourceRun {
  return {
    id: src.id, name: src.name, town: src.town, url, fetch: src.fetch,
    status, events: 0, followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
  };
}

/** Fetch wg strategii źródła; 403/429 przy zwykłym fetchu to zwykle anty-bot — jedna próba przez headless. */
async function fetchSource(src: Source, url: string, run: SourceRun, extraHeaders: Record<string, string> = {}): Promise<Fetched> {
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
      return f;
    } catch {
      throw e; // brak playwrighta albo blokada również dla przeglądarki — raportuj pierwotny błąd
    }
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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
      if (got.notModified) { fr.outcome = "unchanged"; fr.events = cached?.events.length ?? 0; return fr; }
      img = got;
      content = got.data;
      v = { ...(got.etag ? { etag: got.etag } : {}), ...(got.lastModified ? { lastModified: got.lastModified } : {}) };
    } else {
      const sub = await fetchPlain(url, validators(cached));
      if (sub.kind === "not-modified") { fr.outcome = "unchanged"; fr.events = cached?.events.length ?? 0; return fr; }
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
      return fr;
    }

    const added = img
      ? (await extractPoster({ data: img.data, mediaType: img.mediaType }, url)).events
      : (await extractEvents(content, url)).events;

    cache[url] = { hash, events: added, at: new Date().toISOString(), ...v };
    fr.events = added.length;
    return fr;
  } catch (e) {
    const err = describeError(e);
    errors.push({ id: src.id, followup: url, err });
    fr.outcome = "error";
    fr.err = err;
    return fr;
  }
}

/** Wydarzenia followupa — z cache po przetworzeniu (processFollowup zapisuje wynik do state). */
const followupEvents = (url: string, state: PipelineState): EventItem[] =>
  state.extractions?.[url]?.events ?? [];

async function processSource(
  src: Source, state: PipelineState, errors: PipelineError[], fbEventUrls: Set<string>,
): Promise<{ events: EventItem[]; run: SourceRun }> {
  const t0 = performance.now();
  resetUsage();
  beginSource(src.id);
  const bdBefore = bdSnapshot();
  const url = src.url.replace("{page}", "1");
  const run = newSourceRun(src, url, "empty");
  const finalize = (events: EventItem[]): { events: EventItem[]; run: SourceRun } => {
    run.events = events.length;
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
    return finalize([]);
  }
  run.httpStatus = fetched.httpStatus;

  // --- strona źródła: 304 albo ten sam hash => wydarzenia z cache, bez wywołania LLM ---
  let pageEvents: EventItem[];
  let followupUrls: string[];

  if (fetched.kind === "not-modified" && cached) {
    run.changed = false;
    run.kind = "html";
    pageEvents = cached.events;
    followupUrls = state.followupsBySource?.[src.id] ?? [];
    // 304 = brak treści do przeszukania — linki do wydarzeń FB wracają ze stanu
    if (bdEnabled()) for (const u of state.fbUrlsBySource?.[src.id] ?? []) fbEventUrls.add(u);
  } else {
    run.kind = fetched.kind === "pdf" ? "pdf" : "html";
    run.chars = fetched.text.length;
    await archiveRaw(src.id, url, fetched.text, fetched.kind);
    if (!fetched.text.trim()) { run.status = "empty"; return finalize([]); }

    // linki facebook.com/events/… w treści — rozwiązywane zbiorczo na końcu przebiegu
    if (bdEnabled()) {
      const found = harvestEventUrls(fetched.text);
      (state.fbUrlsBySource ??= {})[src.id] = found;
      for (const u of found) fbEventUrls.add(u);
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
    } else {
      run.changed = true;
      const result = await extractEvents(fetched.text, url);
      pageEvents = [...(result.events ?? [])];
      cache[src.id] = { hash, events: pageEvents, at: new Date().toISOString(), ...v };
      state.hashes[src.id] = hash; // legacy, dla zgodności ze starym state.json
      followupUrls = (result.followups ?? []).slice(0, MAX_FOLLOWUPS_PER_SOURCE).map((f) => f.url);
      (state.followupsBySource ??= {})[src.id] = followupUrls;
    }
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

  for (const ev of events) {
    ev.source_id = src.id;
    ev.town ??= src.town;
    // geocode ma własny cache po "venue|town", więc wydarzenia z cache nie kosztują zapytań
    if (ev.venue) {
      const g = await geocode(ev.venue, ev.town ?? "", state.geo);
      ev.geo = g;
      if (g) run.geo.hits++; else run.geo.misses++;
    }
  }

  const anyFollowupChanged = run.followups.some((f) => f.outcome === "ok");
  if (!run.changed && !anyFollowupChanged) {
    // nic się nie zmieniło — ale wydarzenia wracają z cache zamiast zniknąć z serwisu
    run.status = events.length > 0 ? "unchanged" : "empty";
    run.cached = events.length;
  } else {
    run.status = events.length > 0 ? "ok" : "empty";
    if (!run.changed) run.cached = pageEvents.length;
  }
  return finalize(events);
}

// ---------------- wydarzenia FB (Bright Data, zbiorczo) ----------------

const FB_EVENT_CACHE_PREFIX = "fb-event:";
/** Po tylu dniach rozwiązujemy link ponownie — data/miejsce wydarzenia potrafią się zmienić. */
const FB_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** id z https://www.facebook.com/events/123… — do sparowania rekordu BD z żądanym URL-em. */
const fbEventId = (url: string): string | null => url.match(/events\/(\d+)/i)?.[1] ?? null;

/**
 * Zbiorcze rozwiązanie zebranych linków do wydarzeń FB (link → EventItem, mapowanie
 * strukturalne bez LLM). Wynik per-link żyje w state.extractions pod "fb-event:<url>":
 * znany link nie kosztuje rekordu Bright Data przez FB_EVENT_TTL_MS, a wpisy po
 * zakończonych wydarzeniach (i nieudane próby starsze niż TTL) są usuwane.
 */
async function resolveFbEvents(
  urls: string[], state: PipelineState, errors: PipelineError[],
): Promise<{ events: EventItem[]; run: SourceRun }> {
  const t0 = performance.now();
  resetUsage();
  beginSource("fb-events");
  const bdBefore = bdSnapshot();
  const run: SourceRun = {
    id: "fb-events", name: "Wydarzenia FB (linki)", town: "", url: "https://www.facebook.com/events/",
    fetch: "fb_event", status: "empty", events: 0, followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
  };
  const today = new Date().toISOString().slice(0, 10);
  const cache = (state.extractions ??= {});

  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith(FB_EVENT_CACHE_PREFIX)) continue;
    const stale = entry.events.length
      ? entry.events.every((ev) => (ev.date_end ?? ev.date_start) < today) // zakończone
      : Date.now() - Date.parse(entry.at) > FB_EVENT_TTL_MS; // nierozwiązane — po TTL wolno spróbować znowu
    if (stale) delete cache[key];
  }

  const events: EventItem[] = [];
  const toResolve: string[] = [];
  for (const url of urls) {
    const entry = cache[FB_EVENT_CACHE_PREFIX + url];
    if (entry && Date.now() - Date.parse(entry.at) <= FB_EVENT_TTL_MS) events.push(...entry.events);
    else toResolve.push(url);
  }
  const fromCache = events.length;

  const capped = toResolve.slice(0, MAX_FB_EVENTS_PER_RUN);
  if (toResolve.length > capped.length) {
    run.note = `limit ${MAX_FB_EVENTS_PER_RUN}/przebieg — pominięto ${toResolve.length - capped.length} linków`;
  }

  if (capped.length) {
    try {
      const records = await bdCollect(BD_DATASETS.fbEvents, capped);
      await archiveRaw("fb-events", "https://www.facebook.com/events/ (zbiorczo)", JSON.stringify(records, null, 1), "fb_event");
      const byId = new Map<string, EventItem[]>();
      for (const rec of records) {
        const ev = fbEventToItem(rec, today);
        if (!ev) continue;
        ev.source_id = "fb-event";
        if (ev.venue) {
          const g = await geocode(ev.venue, ev.town ?? "", state.geo);
          ev.geo = g;
          if (g) run.geo.hits++; else run.geo.misses++;
        }
        const id = fbEventId(ev.source_url);
        if (id) byId.set(id, [...(byId.get(id) ?? []), ev]);
        events.push(ev);
      }
      // wynik per żądany link do cache — także pusty (nie ponawiamy nieudanych przed TTL)
      for (const url of capped) {
        const id = fbEventId(url);
        cache[FB_EVENT_CACHE_PREFIX + url] = { hash: url, events: (id ? byId.get(id) : undefined) ?? [], at: new Date().toISOString() };
      }
    } catch (e) {
      bdUsage.errors += 1;
      const err = describeError(e);
      errors.push({ id: "fb-events", err });
      run.status = "error";
      run.err = err;
    }
  }

  run.events = events.length;
  run.cached = fromCache;
  if (run.status !== "error") run.status = events.length ? (capped.length ? "ok" : "unchanged") : "empty";
  run.llm = snapshotUsage();
  const bd = bdDelta(bdBefore);
  if (bd) run.bd = bd;
  run.ms = Math.round(performance.now() - t0);
  const paths = sourcePaths();
  if (paths.length) run.archive = paths;
  console.log(`FB: ${events.length} wydarzeń z linków (${fromCache} z cache, ${capped.length} wysłanych do Bright Data)`);
  return { events, run };
}

async function renderHtml(data: EventsFile, report: RunReport): Promise<void> {
  const tpl = await readFile(TEMPLATE_HTML, "utf-8");
  const runView = { startedAt: report.startedAt, totals: report.totals };
  const html = tpl
    .replace("/*__EVENTS__*/", JSON.stringify(data))
    .replace("/*__RUN__*/", JSON.stringify(runView));
  await writeFile(INDEX_HTML, html, "utf-8");
}

// ---------------- run report ----------------

function buildReport(startedAt: string, t0: number, sources: SourceRun[], pii: RedactionStats): RunReport {
  const totals: RunTotals = {
    sources: sources.length, ok: 0, unchanged: 0, errors: 0, skippedFb: 0, skippedDead: 0, empty: 0,
    events: 0, followupsTried: 0, geoHits: 0, geoMisses: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    redactedPhones: pii.phones, redactedEmails: pii.emails,
  };
  for (const s of sources) {
    if (s.status === "ok") totals.ok++;
    else if (s.status === "unchanged") totals.unchanged++;
    else if (s.status === "error") totals.errors++;
    else if (s.status === "skipped-fb") totals.skippedFb++;
    else if (s.status === "skipped-dead") totals.skippedDead++;
    else totals.empty++;
    totals.events += s.events;
    totals.followupsTried += s.followups.length;
    totals.geoHits += s.geo.hits;
    totals.geoMisses += s.geo.misses;
    totals.calls += s.llm.calls;
    totals.promptTokens += s.llm.promptTokens;
    totals.completionTokens += s.llm.completionTokens;
    totals.costUsd += s.llm.costUsd;
  }
  return {
    stage: "daily", startedAt, finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0), totals, sources,
  };
}

// ---------------- koszty ----------------

/** Zużycie jednego rodzaju zadania LLM w całym przebiegu + najdroższe źródła. */
function taskCost(sources: SourceRun[], task: LlmTask): CostInput | null {
  let calls = 0, tokensIn = 0, tokensOut = 0, usd = 0;
  const drivers: CostDriver[] = [];
  for (const s of sources) {
    const u = s.llmByTask?.[task];
    if (!u?.calls) continue;
    calls += u.calls;
    tokensIn += u.promptTokens;
    tokensOut += u.completionTokens;
    usd += u.costUsd;
    drivers.push({ id: s.id, usd: u.costUsd, units: u.calls });
  }
  if (!calls) return null;
  return {
    category: task === "poster" ? "llm-vision" : "llm-extract",
    // OpenRouter zwraca `cost` przy każdym wywołaniu — to kwota, nie nasz szacunek
    usd, estimated: false, units: calls, unit: "calls", tokensIn, tokensOut, drivers,
  };
}

/**
 * Koszt przebiegu w rozbiciu na kategorie. Zapisujemy też pozycje o stawce zero
 * (fetch, geo, storage): darmowy tier to koszt zero **do limitu**, a bez zapisanego
 * wolumenu pierwszy rachunek za przekroczenie nie ma z czym się skonfrontować.
 */
function buildCosts(report: RunReport, archiveBytes: number): CostEntry[] {
  const rates = costRates();
  const inputs: CostInput[] = [];
  for (const task of ["extract", "poster"] as const) {
    const c = taskCost(report.sources, task);
    if (c) inputs.push(c);
  }

  const bd = report.brightdata;
  if (bd?.records || bd?.triggers) {
    inputs.push({
      category: "fb",
      // Bright Data rozlicza per-rekord i nie zwraca kwoty — to iloczyn wolumenu i stawki
      usd: bd.records * rates.bdPerRecord,
      estimated: true,
      units: bd.records,
      unit: "records",
      drivers: report.sources
        .filter((s) => s.bd?.records)
        .map((s) => ({ id: s.id, usd: (s.bd?.records ?? 0) * rates.bdPerRecord, units: s.bd?.records ?? 0 })),
    });
  }

  inputs.push({
    category: "scrape",
    usd: netUsage.fetches * rates.scrapePerFetch,
    estimated: true,
    units: netUsage.fetches,
    unit: "fetches",
  });
  inputs.push({
    category: "geo",
    usd: 0, // Nominatim jest darmowy; ograniczeniem jest 1 req/s, nie cena
    estimated: true,
    units: netUsage.geoLookups,
    unit: "lookups",
  });
  if (archiveBytes) {
    const gb = archiveBytes / 1024 ** 3;
    inputs.push({
      category: "storage",
      // obiekty z tego przebiegu zajmują miejsce przez ARCHIVE_RETENTION_DAYS
      usd: gb * rates.storagePerGbMonth * (ARCHIVE_RETENTION_DAYS / 30),
      estimated: true,
      units: archiveBytes / 1024 ** 2,
      unit: "MB",
    });
  }
  return costEntries("daily", report.startedAt, inputs);
}

/** Dopisz przebieg do runs.json, przycinając do ostatnich 7 dni (min. RUN_MIN_KEEP, maks. RUN_MAX_KEEP). */
async function persistRun(report: RunReport): Promise<void> {
  const prev = await loadJson<RunReport[]>(RUNS_PATH, []);
  const all = [...prev, report];
  const cutoff = Date.now() - RUN_RETENTION_MS;
  const recent = all.filter((r) => Date.parse(r.startedAt) >= cutoff);
  const kept = recent.length >= RUN_MIN_KEEP ? recent : all.slice(-RUN_MIN_KEEP);
  await writeFile(RUNS_PATH, JSON.stringify(kept.slice(-RUN_MAX_KEEP), null, 1), "utf-8");
}

const STATUS_ICON: Record<SourceRun["status"], string> = {
  ok: "✅", unchanged: "♻️", error: "⚠️", "skipped-fb": "⏭️", "skipped-dead": "💀", empty: "∅",
};

/** Tabela statusu do GitHub Actions job summary (Markdown). */
function writeStepSummary(report: RunReport): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`## daily-events — ${report.startedAt}`, "");
  lines.push(
    `**${t.sources}** źródeł · ✅ ${t.ok} ok · ♻️ ${t.unchanged} bez zmian · ` +
    `⚠️ ${t.errors} błędów · ⏭️ ${t.skippedFb} fb · 💀 ${t.skippedDead} martwych · ∅ ${t.empty} pusto · ` +
    `**${t.events}** wydarzeń · ${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `🔒 ${t.redactedPhones} tel. / ${t.redactedEmails} e-mail zredagowanych · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  if (report.costs?.length) {
    // rozpiska kosztu w summary: „droższy niż zwykle" widać wtedy w logu Actions,
    // bez wchodzenia do panelu
    lines.push(`**Koszt:** ${costLine(report.costs)} · \`~\` = szacunek ze stawki, nie kwota od dostawcy`, "");
    lines.push("| kategoria | koszt | wolumen | tokeny |");
    lines.push("|---|--:|--:|--:|");
    for (const c of [...report.costs].sort((a, b) => b.usd - a.usd)) {
      const tok = c.tokensIn ? `${c.tokensIn}+${c.tokensOut ?? 0}` : "";
      lines.push(`| ${c.category}${c.estimated ? " ~" : ""} | $${c.usd.toFixed(4)} | ${c.units} ${c.unit} | ${tok} |`);
    }
    lines.push("");
  }
  lines.push("| źródło | status | http | wyd. | followups | tokeny | ms |");
  lines.push("|---|---|--:|--:|:--:|--:|--:|");
  for (const s of report.sources) {
    const fu = s.followups.length
      ? `${s.followups.filter((f) => f.outcome !== "error").length}/${s.followups.length}` +
        (s.followupsRechecked ? " ↻" : "")
      : "";
    const tok = s.llm.calls ? `${s.llm.promptTokens}+${s.llm.completionTokens}` : "";
    lines.push(
      `| ${s.id} | ${STATUS_ICON[s.status]} ${s.status} | ${s.httpStatus ?? ""} | ` +
      `${s.events || ""} | ${fu} | ${tok} | ${s.ms || ""} |`,
    );
  }
  lines.push("");
  appendFileSync(path, lines.join("\n") + "\n", "utf-8");
}

function summaryLine(r: RunReport): string {
  const t = r.totals;
  return (
    `OK: ${t.events} wydarzeń · ${t.ok} ok / ${t.unchanged} bez zmian / ${t.errors} błędów / ` +
    `${t.skippedFb} fb / ${t.skippedDead} martwych / ${t.empty} pusto · ${t.calls} LLM · ` +
    `koszt ${costLine(r.costs ?? [])} · ` +
    `PII: −${t.redactedPhones} tel. −${t.redactedEmails} e-mail · ${Math.round(r.durationMs / 1000)}s`
  );
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  beginRun(startedAt);
  if (archiveEnabled()) {
    setCallRecorder(archiveLlmCall);
    console.log("archiwum: włączone (Supabase Storage)");
  }
  const cfg = JSON.parse(await readFile(SOURCES_PATH, "utf-8")) as SourcesFile;
  const state = await loadJson<PipelineState>(STATE_PATH, { hashes: {}, geo: {} });
  const errors: PipelineError[] = [];
  const sourceRuns: SourceRun[] = [];
  let allEvents: EventItem[] = [];
  // linki do wydarzeń FB zebrane po drodze (treści stron, followupy, posty grup) — rozwiązywane zbiorczo na końcu
  const fbEventUrls = new Set<string>();

  for (const src of cfg.sources) {
    if (src.fetch === "fb" || ((src.fetch === "fb_group" || src.fetch === "fb_event") && !bdEnabled())) {
      // fanpage: osobny dataset Bright Data, poza zakresem daily; fb_group/fb_event bez klucza → tryb zero-cost
      if (bdEnabled() && isEventUrl(src.url)) for (const u of harvestEventUrls(src.url)) fbEventUrls.add(u);
      sourceRuns.push(newSourceRun(src, src.url.replace("{page}", "1"), "skipped-fb"));
      continue;
    }
    if (src.fetch === "fb_event") {
      // pojedynczy link do wydarzenia — dołącza do zbiorczego rozwiązania
      for (const u of harvestEventUrls(src.url)) fbEventUrls.add(u);
      const sr = newSourceRun(src, src.url, "skipped-fb");
      sr.note = "rozwiązywane zbiorczo — patrz wiersz fb-events";
      sourceRuns.push(sr);
      continue;
    }
    if (src.dead) {
      // martwy URL wg discover --verify — nie marnujemy fetcha do następnej naprawy
      sourceRuns.push(newSourceRun(src, src.url.replace("{page}", "1"), "skipped-dead"));
      continue;
    }
    const { events, run: sr } = await processSource(src, state, errors, fbEventUrls);
    sourceRuns.push(sr);
    allEvents.push(...events);
  }

  if (bdEnabled() && fbEventUrls.size) {
    const { events, run: fbRun } = await resolveFbEvents([...fbEventUrls], state, errors);
    sourceRuns.push(fbRun);
    allEvents.push(...events);
  }

  allEvents = dedupe(allEvents);

  // pełna wersja (z kontaktami) do prywatnego archiwum — MUSI polecieć przed redakcją
  await archiveEventsFull({ generated: new Date().toISOString().slice(0, 10), startedAt, events: allEvents, errors });

  // PII wychodzi tuż przed zapisem: dedupe pracuje na pełnych danych, a do repo (events.json,
  // index.html, runs.json, job summary) trafia już wersja zredagowana. Komunikaty błędów też —
  // potrafią nieść fragment treści strony.
  const pii = redactEvents(allEvents);
  // state.json też jest w repo — cache ekstrakcji trzyma wydarzenia, więc redagujemy i jego.
  // Redakcja jest idempotentna, a część obiektów jest współdzielona z allEvents (to samo id w pamięci).
  for (const entry of Object.values(state.extractions ?? {})) redactEvents(entry.events);
  for (const e of errors) e.err = redactText(e.err, pii);
  for (const sr of sourceRuns) {
    if (sr.err) sr.err = redactText(sr.err, pii);
    for (const fu of sr.followups) if (fu.err) fu.err = redactText(fu.err, pii);
  }

  const out: EventsFile = { generated: new Date().toISOString().slice(0, 10), events: allEvents, errors };
  if (bdEnabled()) out.brightdata = bdUsage;
  const report = buildReport(startedAt, t0, sourceRuns, pii);
  if (bdEnabled()) report.brightdata = bdUsage;
  // koszt liczymy po zbudowaniu raportu (ma już wszystkie źródła) i przed zapisem,
  // żeby ta sama rozpiska poszła do runs.json, costs.json i na stdout
  report.costs = buildCosts(report, archiveStats().bytes);

  await writeFile(EVENTS_PATH, JSON.stringify(out, null, 1), "utf-8");
  await writeFile(STATE_PATH, JSON.stringify(state), "utf-8");
  await persistRun(report);
  await recordCosts(report.costs);
  await renderHtml(out, report);
  writeStepSummary(report);
  console.log(summaryLine(report));
  if (bdEnabled()) {
    // log zużycia per przebieg → policzenie kosztu (snapshot_id pozwala ponownie pobrać dane z BD za darmo)
    await appendFile(BD_USAGE_LOG, `${JSON.stringify({ date: out.generated, at: new Date().toISOString(), ...bdUsage })}\n`, "utf-8");
    console.log(
      `Bright Data: ${bdUsage.triggers} trigger · ${bdUsage.inputs} URL · ${bdUsage.records} rekordów · ` +
      `${bdUsage.polls} polls · ${bdUsage.errors} błędów`,
    );
  }
  if (archiveEnabled()) {
    const a = archiveStats();
    console.log(
      `archiwum: ${a.uploaded} obiektów (${(a.bytes / 1024 / 1024).toFixed(2)} MB)` +
      (a.failed ? `, ${a.failed} błędów` : ""),
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
