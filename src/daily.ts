/**
 * Stage 2: codzienny pipeline ekstrakcji wydarzeń.
 * sources.json -> fetch -> diff -> LLM (Haiku) -> expand followups (PDF/podstrony/plakaty)
 * -> geocode -> dedupe -> events.json -> index.html
 *
 * Uruchomienie: ANTHROPIC_API_KEY=... npm run daily
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { convert as htmlToText } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";

import { MODEL_EXTRACT, chat, imagePart } from "./llm.js";
import { DEDUPE_SYSTEM, POSTER_SYSTEM, extractionSystem } from "./prompts.js";
import type {
  EventItem, EventsFile, ExtractionResult, PipelineError, PipelineState, Source, SourcesFile,
} from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, "state.json");
const OUT_EVENTS = join(ROOT, "events.json");
const UA = { "User-Agent": "LocalEventsBot/0.3 (+kontakt: twoj@email)" };
const MAX_FOLLOWUPS_PER_SOURCE = 5;
const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

// ---------------- fetch ----------------

type Fetched = { kind: "html" | "pdf" | "skip"; text: string };

async function fetchPlain(url: string): Promise<Fetched> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return { kind: "pdf", text };
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
  return { kind: "html", text };
}

async function fetchHeadless(url: string): Promise<Fetched> {
  // playwright jest optionalDependency — dynamiczny import przez zmienną,
  // żeby typecheck przechodził bez zainstalowanego pakietu
  interface MinimalPage { goto(u: string, o: { waitUntil: string; timeout: number }): Promise<unknown>; content(): Promise<string> }
  interface MinimalBrowser { newPage(): Promise<MinimalPage>; close(): Promise<void> }
  const modName = "playwright";
  const { chromium } = (await import(modName)) as { chromium: { launch(): Promise<MinimalBrowser> } };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const html = await page.content();
    return { kind: "html", text: htmlToText(html, { wordwrap: false }) };
  } finally {
    await browser.close();
  }
}

/** Plakat JPG/PNG -> base64 dla modelu wizyjnego. */
async function fetchImageB64(url: string): Promise<{ data: string; mediaType: "image/jpeg" | "image/png" } | null> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 5_000_000) return null;
  return {
    data: buf.toString("base64"),
    mediaType: /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg",
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
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
    maxTokens: 4000,
  });
  return parseJson(out);
}

async function extractPoster(img: { data: string; mediaType: "image/jpeg" | "image/png" }, sourceUrl: string): Promise<ExtractionResult> {
  const out = await chat({
    model: MODEL_EXTRACT,
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
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "json", limit: "1" })}`,
      { headers: UA, signal: AbortSignal.timeout(15_000) },
    );
    const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = hits[0];
    cache[key] = hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
  } catch {
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

async function processSource(src: Source, state: PipelineState, errors: PipelineError[]): Promise<EventItem[]> {
  const url = src.url.replace("{page}", "1");
  let fetched: Fetched;
  try {
    fetched = src.fetch === "headless" ? await fetchHeadless(url) : await fetchPlain(url);
  } catch (e) {
    errors.push({ id: src.id, err: String(e) });
    return [];
  }
  if (!fetched.text.trim()) return [];

  // diff: nie płacimy za niezmienione strony
  const hash = createHash("sha256").update(fetched.text).digest("hex");
  if (state.hashes[src.id] === hash) return [];
  state.hashes[src.id] = hash;

  const result = await extractEvents(fetched.text, url);
  const events: EventItem[] = [...(result.events ?? [])];

  // rozwijanie kontenerów: PDF-y programów, podstrony, plakaty (1 hop)
  for (const fu of (result.followups ?? []).slice(0, MAX_FOLLOWUPS_PER_SOURCE)) {
    try {
      if (/\.(jpe?g|png)(\?|$)/i.test(fu.url)) {
        const img = await fetchImageB64(fu.url);
        if (img) events.push(...(await extractPoster(img, fu.url)).events);
      } else {
        const sub = await fetchPlain(fu.url);
        events.push(...(await extractEvents(sub.text, fu.url)).events);
      }
    } catch (e) {
      errors.push({ id: src.id, followup: fu.url, err: String(e) });
    }
  }

  for (const ev of events) {
    ev.source_id = src.id;
    ev.town ??= src.town;
    if (ev.venue) ev.geo = await geocode(ev.venue, ev.town ?? "", state.geo);
  }
  return events;
}

async function renderHtml(data: EventsFile): Promise<void> {
  const tpl = await readFile(join(ROOT, "template.html"), "utf-8");
  await writeFile(join(ROOT, "index.html"), tpl.replace("/*__EVENTS__*/", JSON.stringify(data)), "utf-8");
}

async function run(): Promise<void> {
  const cfg = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf-8")) as SourcesFile;
  const state = await loadJson<PipelineState>(STATE_PATH, { hashes: {}, geo: {} });
  const errors: PipelineError[] = [];
  let allEvents: EventItem[] = [];

  for (const src of cfg.sources) {
    if (src.fetch === "fb") continue; // wymaga zewn. scrapera (Apify/BrightData) — patrz README
    allEvents.push(...(await processSource(src, state, errors)));
  }

  allEvents = dedupe(allEvents);
  const out: EventsFile = { generated: new Date().toISOString().slice(0, 10), events: allEvents, errors };
  await writeFile(OUT_EVENTS, JSON.stringify(out, null, 1), "utf-8");
  await writeFile(STATE_PATH, JSON.stringify(state), "utf-8");
  await renderHtml(out);
  console.log(`OK: ${allEvents.length} wydarzeń, ${errors.length} błędów`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
