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
import { describeError } from "../../shared/errors.js";
import type { EventItem, PipelineError, PipelineState, SourceRun } from "../../types/index.js";
import { fbEventToItem } from "../facebook.js";

/** Górny limit rozwiązywanych linków na przebieg — bezpiecznik kosztów Bright Data. */
const MAX_FB_EVENTS_PER_RUN = Number(process.env["BD_MAX_FB_EVENTS"] ?? 40);

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
