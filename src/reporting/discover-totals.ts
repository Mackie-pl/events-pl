/** Agregaty przebiegu discover: liczniki werdyktów, zapytań i zużycia LLM. */
import { searchState } from "../adapters/search.js";
import type { DiscoverRunReport, DiscoverTotals, LlmUsage, SearchCall } from "../types/index.js";

export function emptyTotals(): DiscoverTotals {
  return {
    towns: 0, searches: 0, searchErrors: 0, searchesSkipped: 0,
    sourcesAdded: 0, proposalsRejected: 0, sourcesChecked: 0,
    ok: 0, fixed: 0, dead: 0, unrepaired: 0, skipped: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    costDiscoveryUsd: 0, costVerifyUsd: 0,
    redactedPhones: 0, redactedEmails: 0,
  };
}

function addUsage(t: DiscoverTotals, u: LlmUsage): void {
  t.calls += u.calls;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.costUsd += u.costUsd;
}

function countSearches(t: DiscoverTotals, calls: SearchCall[]): void {
  for (const c of calls) {
    if (c.skipped) continue; // niewysłane nie zużyły limitu
    t.searches++;
    if (c.err) t.searchErrors++;
  }
}

export function buildTotals(report: DiscoverRunReport): void {
  const t = report.totals;
  t.towns = report.towns.length;
  t.searchesSkipped = searchState().skipped;
  for (const town of report.towns) {
    countSearches(t, town.searches);
    t.sourcesAdded += town.added;
    t.proposalsRejected += town.proposals.filter((p) => p.decision !== "added").length;
    t.costDiscoveryUsd += town.llm.costUsd;
    addUsage(t, town.llm);
  }
  for (const v of report.verifications) {
    countSearches(t, v.searches);
    t.sourcesChecked += v.outcome === "skipped" ? 0 : 1;
    if (v.outcome === "ok") t.ok++;
    else if (v.outcome === "fixed") t.fixed++;
    else if (v.outcome === "dead") t.dead++;
    else if (v.outcome === "error") t.unrepaired++;
    else t.skipped++;
    t.costVerifyUsd += v.llm.costUsd;
    addUsage(t, v.llm);
  }
}

/**
 * Koszt przebiegu w rozbiciu na kategorie (costs.json). Discovery i weryfikacja to ten sam
 * rachunek w OpenRouterze, ale zupełnie różne pozycje w budżecie: pierwsza jest droga
 * i jednorazowa (Sonnet, nowe miasto), druga tania i comiesięczna (Haiku, naprawa URL-i).
 * Zapytania Brave idą osobno — darmowy tier 2000/mies. kończy się cicho, więc wolumen
 * musi być zapisany także wtedy, gdy stawka wynosi zero.
 */
