/**
 * Zbiorcze rozwiązywanie linków facebook.com/events/… przez Bright Data.
 *
 * UWAGA: FB_EVENT_CACHE_PREFIX i FB_EVENT_TTL_MS są kluczami cache w state.json.
 * Zmiana którejkolwiek stałej unieważnia cache i kosztuje pełną, PŁATNĄ paczkę rekordów
 * przy najbliższym przebiegu.
 */
import {
  BD_DATASETS, bdDelta, bdSnapshot, bdUsage, collect as bdCollect,
} from "../../adapters/brightdata.js";
import { geocode } from "../../adapters/nominatim.js";
import { resetUsage, snapshotUsage } from "../../adapters/openrouter.js";
import { archiveRaw, beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { describeError } from "../../shared/errors.js";
import type {
  BdUsage, EventItem, PipelineError, PipelineState, SourceRun,
} from "../../types/index.js";
import { fbEventToItem } from "../facebook.js";

import { detach, lastDay } from "./block-cache.js";

/** Górny limit rozwiązywanych linków na przebieg — bezpiecznik kosztów Bright Data. */
const MAX_FB_EVENTS_PER_RUN = (): number => P.BD_MAX_FB_EVENTS.get();

const FB_EVENT_CACHE_PREFIX = "fb-event:";
/** Po tylu dniach rozwiązujemy link ponownie — data/miejsce wydarzenia potrafią się zmienić. */
const FB_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** id z https://www.facebook.com/events/123… — do sparowania rekordu BD z żądanym URL-em. */
const fbEventId = (url: string): string | null => url.match(/events\/(\d+)/i)?.[1] ?? null;

type FbCache = NonNullable<PipelineState["extractions"]>;

/** Wyrzuca z cache wpisy zakończone oraz nierozwiązane po TTL (wtedy wolno spróbować ponownie). */
function pruneFbCache(cache: FbCache, today: string): void {
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith(FB_EVENT_CACHE_PREFIX)) continue;
    const stale = entry.events.length
      ? entry.events.every((ev) => lastDay(ev) < today)
      : Date.now() - Date.parse(entry.at) > FB_EVENT_TTL_MS;
    if (stale) delete cache[key];
  }
}

function partitionByCache(
  urls: string[], cache: FbCache,
): { cached: EventItem[]; toResolve: string[] } {
  const cached: EventItem[] = [];
  const toResolve: string[] = [];
  for (const url of urls) {
    const entry = cache[FB_EVENT_CACHE_PREFIX + url];
    if (entry && Date.now() - Date.parse(entry.at) <= FB_EVENT_TTL_MS) {
      cached.push(...detach(entry.events));
    }
    else toResolve.push(url);
  }
  return { cached, toResolve };
}

/** Współrzędne miejsca, jeśli w ogóle je znamy. Liczniki trafień idą do raportu przebiegu. */
async function geocodeEvent(ev: EventItem, state: PipelineState, run: SourceRun): Promise<void> {
  if (!ev.venue && !ev.town) return;
  const g = await geocode(ev.venue, ev.town, state.geo);
  ev.geo = g.pin;
  ev.locality = g.where;
  // liczniki zostają przy pytaniu O ADRES: wpis bez `venue` nie jest pudłem geokodera
  if (ev.venue) { if (g.pin) run.geo.hits++; else run.geo.misses++; }
}

/**
 * Jedno zbiorcze żądanie do Bright Data + geokodowanie wyników. Do cache trafia wynik
 * KAŻDEGO żądanego linku, także pusty — inaczej nieudane linki byłyby ponawiane
 * (i płatne) przy każdym przebiegu, zamiast dopiero po TTL.
 */
async function collectFbEvents(
  capped: string[],
  today: string,
  run: SourceRun,
  ctx: { state: PipelineState; cache: FbCache },
): Promise<EventItem[]> {
  const { state, cache } = ctx;
  const records = await bdCollect(BD_DATASETS.fbEvents, capped);
  // migawka lądowała w archiwum od zawsze, ale ścieżkę wyrzucaliśmy — więc ślad mówił „tyle
  // wydarzeń", a „dlaczego akurat tyle" (rekordy bez daty, bez miejsca, wiersze błędu) dało
  // się sprawdzić tylko zgadując, który obiekt z listy archiwum to ta paczka
  const archive = await archiveRaw(
    "fb-events", "https://www.facebook.com/events/ (zbiorczo)",
    JSON.stringify(records, null, 1), "fb_event",
  );
  audit("fetch",
    `Bright Data oddał ${records.length} rekordów na ${capped.length} linków`,
    { records: records.length, links: capped.length, ...(archive ? { archive } : {}) });
  const out: EventItem[] = [];
  const byId = new Map<string, EventItem[]>();
  for (const rec of records) {
    const ev = fbEventToItem(rec, today);
    if (!ev) continue;
    ev.source_id = "fb-event";
    await geocodeEvent(ev, state, run);
    const id = fbEventId(ev.source_url);
    if (id) byId.set(id, [...(byId.get(id) ?? []), ev]);
    out.push(ev);
  }
  for (const url of capped) {
    const id = fbEventId(url);
    const hit = (id ? byId.get(id) : undefined) ?? [];
    cache[FB_EVENT_CACHE_PREFIX + url] = {
      hash: url, events: detach(hit), at: new Date().toISOString(),
    };
  }
  return out;
}

/**
 * Domknięcie raportu źródła. Musi zostać TU, a nie w wywołującym: snapshotUsage() i
 * sourcePaths() czytają liczniki modułowe, których granicą jest właśnie to „jedno źródło".
 */
function finalize(
  run: SourceRun,
  m: { events: number; fromCache: number; sent: number; bdBefore: BdUsage; t0: number },
): void {
  run.events = m.events;
  run.cached = m.fromCache;
  if (run.status !== "error") run.status = m.events ? (m.sent ? "ok" : "unchanged") : "empty";
  run.llm = snapshotUsage();
  const bd = bdDelta(m.bdBefore);
  if (bd) run.bd = bd;
  run.ms = Math.round(performance.now() - m.t0);
  const paths = sourcePaths();
  if (paths.length) run.archive = paths;
}

/**
 * Zbiorcze rozwiązanie zebranych linków do wydarzeń FB (link → EventItem, mapowanie
 * strukturalne bez LLM). Wynik per-link żyje w state.extractions pod "fb-event:<url>":
 * znany link nie kosztuje rekordu Bright Data przez FB_EVENT_TTL_MS, a wpisy po
 * zakończonych wydarzeniach (i nieudane próby starsze niż TTL) są usuwane.
 */
export async function resolveFbEvents(
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

  pruneFbCache(cache, today);

  const { cached, toResolve } = partitionByCache(urls, cache);
  const events: EventItem[] = [...cached];
  const fromCache = events.length;

  const capped = toResolve.slice(0, MAX_FB_EVENTS_PER_RUN());
  if (toResolve.length > capped.length) {
    run.note = `limit ${MAX_FB_EVENTS_PER_RUN()}/przebieg — pominięto ${toResolve.length - capped.length} linków`;
  }

  if (capped.length) {
    try {
      events.push(...(await collectFbEvents(capped, today, run, { state, cache })));
    } catch (e) {
      bdUsage.errors += 1;
      const err = describeError(e);
      errors.push({ id: "fb-events", err });
      run.status = "error";
      run.err = err;
    }
  }

  finalize(run, { events: events.length, fromCache, sent: capped.length, bdBefore, t0 });
  console.log(
    `FB: ${events.length} wydarzeń z linków ` +
    `(${fromCache} z cache, ${capped.length} wysłanych do Bright Data)`,
  );
  return { events, run };
}
