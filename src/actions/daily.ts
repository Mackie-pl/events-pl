/**
 * Stage 2: codzienny pipeline ekstrakcji wydarzeń.
 * sources.json -> fetch -> diff -> LLM (Haiku) -> expand followups (PDF/podstrony/plakaty)
 * -> geocode -> dedupe -> events.json -> index.html
 *
 * Uruchomienie: ANTHROPIC_API_KEY=... npm run daily
 */
import { appendFile } from "node:fs/promises";

import { bdEnabled, bdUsage } from "../adapters/brightdata.js";
import { setCallRecorder } from "../adapters/openrouter.js";
import {
  archiveEnabled, archiveEventsFull, archiveLlmCall, archiveStats, beginRun,
} from "../adapters/supabase-archive.js";
import { dedupe } from "../pipeline/dedupe.js";
import { harvestEventUrls, isEventUrl } from "../pipeline/facebook.js";
import { resolveFbEvents } from "../pipeline/extract/fb-events.js";
import { newSourceRun, processSource } from "../pipeline/extract/process-source.js";
import { redactEvents, redactText } from "../pipeline/pii.js";
import { recordCosts } from "../reporting/cost-ledger.js";
import { buildDailyCosts } from "../reporting/daily-costs.js";
import { buildReport, dailyRunsStore } from "../reporting/daily-report.js";
import { summaryLine, writeDailySummary } from "../reporting/daily-summary.js";
import { renderHtml } from "../reporting/render-index.js";
import { BD_USAGE_LOG } from "../shared/paths.js";
import { eventsStore, sourcesStore, stateStore } from "../storage/index.js";
import type {
  EventItem, EventsFile, PipelineError, SourceRun,
} from "../types/index.js";

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  beginRun(startedAt);
  if (archiveEnabled()) {
    setCallRecorder(archiveLlmCall);
    console.log("archiwum: włączone (Supabase Storage)");
  }
  const cfg = await sourcesStore.load();
  const state = await stateStore.load();
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
  report.costs = buildDailyCosts(report, archiveStats().bytes);

  await eventsStore.save(out);
  await stateStore.save(state);
  await dailyRunsStore.append([report]);
  await recordCosts(report.costs);
  await renderHtml(out, report);
  writeDailySummary(report);
  console.log(summaryLine(report));
  if (bdEnabled()) {
    // log zużycia per przebieg → policzenie kosztu
    // (snapshot_id pozwala ponownie pobrać dane z BD za darmo)
    const entry = { date: out.generated, at: new Date().toISOString(), ...bdUsage };
    await appendFile(BD_USAGE_LOG, `${JSON.stringify(entry)}\n`, "utf-8");
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
