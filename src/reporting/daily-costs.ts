/** Koszt przebiegu daily w rozbiciu na kategorie. */
import { geoStats } from "../adapters/nominatim.js";
import { fetchStats } from "../adapters/page-fetch.js";
import { RETENTION_DAYS as ARCHIVE_RETENTION_DAYS } from "../adapters/supabase-archive.js";
import type { CostDriver, CostEntry, LlmTask, RunReport, SourceRun } from "../types/index.js";

import { type CostInput, costEntries, costRates } from "./cost-ledger.js";

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
export function buildDailyCosts(report: RunReport, archiveBytes: number): CostEntry[] {
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
    usd: fetchStats() * rates.scrapePerFetch,
    estimated: true,
    units: fetchStats(),
    unit: "fetches",
  });
  inputs.push({
    category: "geo",
    usd: 0, // Nominatim jest darmowy; ograniczeniem jest 1 req/s, nie cena
    estimated: true,
    units: geoStats(),
    unit: "lookups",
  });
  if (archiveBytes) {
    const gb = archiveBytes / 1024 ** 3;
    inputs.push({
      category: "storage",
      // obiekty z tego przebiegu zajmują miejsce przez ARCHIVE_RETENTION_DAYS
      usd: gb * rates.storagePerGbMonth * (ARCHIVE_RETENTION_DAYS() / 30),
      estimated: true,
      units: archiveBytes / 1024 ** 2,
      unit: "MB",
    });
  }
  return costEntries("daily", report.startedAt, inputs);
}

/** Dopisz przebieg do runs.json, przycinając do ostatnich 7 dni (min. RUN_MIN_KEEP, maks. RUN_MAX_KEEP). */
