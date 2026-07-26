/** Agregaty przebiegu daily + polityka przechowywania runs.json. */
import type { RedactionStats } from "../pipeline/pii.js";
import { collection } from "../storage/index.js";
import type { CollectionStore, Retention } from "../storage/index.js";
import type { RunReport, RunTotals, SourceRun } from "../types/index.js";

export function buildReport(startedAt: string, t0: number, sources: SourceRun[], pii: RedactionStats): RunReport {
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

/**
 * Ile historii przebiegów zostaje w publicznym repo. Dane są zredagowane (pipeline/pii),
 * więc ogranicza nas tylko rozmiar pliku: ~25 kB na przebieg × 1 przebieg/dzień. Tydzień
 * to okno, w którym „od kiedy to źródło zwraca zero?" da się zamknąć bez historii gita.
 * Trend kosztów żyje osobno w costs.json (90 dni), bo jest o dwa rzędy wielkości mniejszy.
 */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const dailyRunsRetention: Retention<RunReport> = {
  at: (r) => r.startedAt,
  cutoff: () => new Date(Date.now() - RUN_RETENTION_MS).toISOString(),
  minKeep: 2,   // zawsze zostaw tyle, nawet po przerwie w cronie
  maxKeep: 30,  // sufit na wypadek wielu ręcznych przebiegów jednego dnia
};

export const dailyRunsStore: CollectionStore<RunReport> =
  collection<RunReport>("runs", dailyRunsRetention);
