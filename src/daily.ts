/**
 * Stage 2: codzienny pipeline ekstrakcji wydarzeń.
 * sources.json -> fetch -> diff -> LLM (Haiku) -> expand followups (PDF/podstrony/plakaty)
 * -> geocode -> dedupe -> events.json -> index.html
 *
 * Uruchomienie: ANTHROPIC_API_KEY=... npm run daily
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { convert as htmlToText } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";

import { MODEL_EXTRACT, chat, imagePart, resetUsage, snapshotUsage } from "./llm.js";
import { DEDUPE_SYSTEM, POSTER_SYSTEM, extractionSystem } from "./prompts.js";
import type {
  EventItem, EventsFile, ExtractionResult, FollowupRun, PipelineError, PipelineState,
  RunReport, RunTotals, Source, SourceRun, SourcesFile,
} from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, "state.json");
const OUT_EVENTS = join(ROOT, "events.json");
const RUNS_PATH = join(ROOT, "runs.json");
const RUN_RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // ostatnie ~2 dni
const RUN_MIN_KEEP = 2; // zawsze zostaw min. tyle przebiegów, nawet po przerwie w cronie
const UA = { "User-Agent": "LocalEventsBot/0.3 (+kontakt: twoj@email)" };
const MAX_FOLLOWUPS_PER_SOURCE = 5;
const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

// ---------------- fetch ----------------

type Fetched = { kind: "html" | "pdf" | "skip"; text: string; httpStatus: number };

/** Błąd HTTP niosący kod statusu, żeby raport mógł go pokazać nawet przy porażce. */
function httpError(status: number, url: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${url}`), { httpStatus: status });
}

async function fetchPlain(url: string): Promise<Fetched> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw httpError(res.status, url);
  const status = res.status;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return { kind: "pdf", text, httpStatus: status };
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
  return { kind: "html", text, httpStatus: status };
}

async function fetchHeadless(url: string): Promise<Fetched> {
  // playwright jest optionalDependency — dynamiczny import przez zmienną,
  // żeby typecheck przechodził bez zainstalowanego pakietu
  interface MinimalResponse { status(): number }
  interface MinimalPage { goto(u: string, o: { waitUntil: string; timeout: number }): Promise<MinimalResponse | null>; content(): Promise<string> }
  interface MinimalBrowser { newPage(): Promise<MinimalPage>; close(): Promise<void> }
  const modName = "playwright";
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

function newSourceRun(src: Source, url: string, status: SourceRun["status"]): SourceRun {
  return {
    id: src.id, name: src.name, town: src.town, url, fetch: src.fetch,
    status, events: 0, followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
  };
}

async function processSource(src: Source, state: PipelineState, errors: PipelineError[]): Promise<{ events: EventItem[]; run: SourceRun }> {
  const t0 = performance.now();
  resetUsage();
  const url = src.url.replace("{page}", "1");
  const run = newSourceRun(src, url, "empty");
  const finalize = (events: EventItem[]): { events: EventItem[]; run: SourceRun } => {
    run.events = events.length;
    run.llm = snapshotUsage();
    run.ms = Math.round(performance.now() - t0);
    return { events, run };
  };

  let fetched: Fetched;
  try {
    fetched = src.fetch === "headless" ? await fetchHeadless(url) : await fetchPlain(url);
  } catch (e) {
    errors.push({ id: src.id, err: String(e) });
    run.status = "error";
    run.err = String(e);
    const hs = (e as { httpStatus?: number }).httpStatus;
    if (typeof hs === "number") run.httpStatus = hs;
    return finalize([]);
  }
  run.httpStatus = fetched.httpStatus;
  run.kind = fetched.kind === "pdf" ? "pdf" : "html";
  run.chars = fetched.text.length;

  if (!fetched.text.trim()) { run.status = "empty"; return finalize([]); }

  // diff: nie płacimy za niezmienione strony
  const hash = createHash("sha256").update(fetched.text).digest("hex");
  if (state.hashes[src.id] === hash) { run.status = "unchanged"; run.changed = false; return finalize([]); }
  state.hashes[src.id] = hash;
  run.changed = true;

  const result = await extractEvents(fetched.text, url);
  const events: EventItem[] = [...(result.events ?? [])];

  // rozwijanie kontenerów: PDF-y programów, podstrony, plakaty (1 hop)
  for (const fu of (result.followups ?? []).slice(0, MAX_FOLLOWUPS_PER_SOURCE)) {
    const isImg = /\.(jpe?g|png)(\?|$)/i.test(fu.url);
    const fr: FollowupRun = { url: fu.url, kind: isImg ? "poster" : "page", outcome: "ok", events: 0 };
    try {
      let added: EventItem[] = [];
      if (isImg) {
        const img = await fetchImageB64(fu.url);
        if (img) added = (await extractPoster(img, fu.url)).events;
      } else {
        const sub = await fetchPlain(fu.url);
        added = (await extractEvents(sub.text, fu.url)).events;
      }
      events.push(...added);
      fr.events = added.length;
    } catch (e) {
      errors.push({ id: src.id, followup: fu.url, err: String(e) });
      fr.outcome = "error";
      fr.err = String(e);
    }
    run.followups.push(fr);
  }

  for (const ev of events) {
    ev.source_id = src.id;
    ev.town ??= src.town;
    if (ev.venue) {
      const g = await geocode(ev.venue, ev.town ?? "", state.geo);
      ev.geo = g;
      if (g) run.geo.hits++; else run.geo.misses++;
    }
  }
  run.status = events.length > 0 ? "ok" : "empty";
  return finalize(events);
}

async function renderHtml(data: EventsFile, report: RunReport): Promise<void> {
  const tpl = await readFile(join(ROOT, "template.html"), "utf-8");
  const runView = { startedAt: report.startedAt, totals: report.totals };
  const html = tpl
    .replace("/*__EVENTS__*/", JSON.stringify(data))
    .replace("/*__RUN__*/", JSON.stringify(runView));
  await writeFile(join(ROOT, "index.html"), html, "utf-8");
}

// ---------------- run report ----------------

function buildReport(startedAt: string, t0: number, sources: SourceRun[]): RunReport {
  const totals: RunTotals = {
    sources: sources.length, ok: 0, unchanged: 0, errors: 0, skippedFb: 0, empty: 0,
    events: 0, followupsTried: 0, geoHits: 0, geoMisses: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
  };
  for (const s of sources) {
    if (s.status === "ok") totals.ok++;
    else if (s.status === "unchanged") totals.unchanged++;
    else if (s.status === "error") totals.errors++;
    else if (s.status === "skipped-fb") totals.skippedFb++;
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

/** Dopisz przebieg do runs.json, przycinając do ostatnich ~2 dni (min. RUN_MIN_KEEP). */
async function persistRun(report: RunReport): Promise<void> {
  const prev = await loadJson<RunReport[]>(RUNS_PATH, []);
  const all = [...prev, report];
  const cutoff = Date.now() - RUN_RETENTION_MS;
  const recent = all.filter((r) => Date.parse(r.startedAt) >= cutoff);
  const kept = recent.length >= RUN_MIN_KEEP ? recent : all.slice(-RUN_MIN_KEEP);
  await writeFile(RUNS_PATH, JSON.stringify(kept, null, 1), "utf-8");
}

const STATUS_ICON: Record<SourceRun["status"], string> = {
  ok: "✅", unchanged: "♻️", error: "⚠️", "skipped-fb": "⏭️", empty: "∅",
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
    `⚠️ ${t.errors} błędów · ⏭️ ${t.skippedFb} fb · ∅ ${t.empty} pusto · ` +
    `**${t.events}** wydarzeń · ${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok, ` +
    `$${t.costUsd.toFixed(4)}) · ${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  lines.push("| źródło | status | http | wyd. | followups | tokeny | ms |");
  lines.push("|---|---|--:|--:|:--:|--:|--:|");
  for (const s of report.sources) {
    const fu = s.followups.length ? `${s.followups.filter((f) => f.outcome === "ok").length}/${s.followups.length}` : "";
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
    `${t.skippedFb} fb / ${t.empty} pusto · ${t.calls} LLM $${t.costUsd.toFixed(4)} · ` +
    `${Math.round(r.durationMs / 1000)}s`
  );
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const cfg = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf-8")) as SourcesFile;
  const state = await loadJson<PipelineState>(STATE_PATH, { hashes: {}, geo: {} });
  const errors: PipelineError[] = [];
  const sourceRuns: SourceRun[] = [];
  let allEvents: EventItem[] = [];

  for (const src of cfg.sources) {
    if (src.fetch === "fb") {
      // wymaga zewn. scrapera (Apify/BrightData) — patrz README; odnotuj jako świadomą lukę
      sourceRuns.push(newSourceRun(src, src.url.replace("{page}", "1"), "skipped-fb"));
      continue;
    }
    const { events, run: sr } = await processSource(src, state, errors);
    sourceRuns.push(sr);
    allEvents.push(...events);
  }

  allEvents = dedupe(allEvents);
  const out: EventsFile = { generated: new Date().toISOString().slice(0, 10), events: allEvents, errors };
  const report = buildReport(startedAt, t0, sourceRuns);

  await writeFile(OUT_EVENTS, JSON.stringify(out, null, 1), "utf-8");
  await writeFile(STATE_PATH, JSON.stringify(state), "utf-8");
  await persistRun(report);
  await renderHtml(out, report);
  writeStepSummary(report);
  console.log(summaryLine(report));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
