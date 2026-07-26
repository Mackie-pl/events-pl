/** Koszt przebiegu discover w rozbiciu na kategorie. */
import { probeStats } from "../pipeline/verify/probe.js";
import type { CostEntry, DiscoverRunReport, LlmUsage } from "../types/index.js";

import { type CostInput, costEntries, costRates } from "./cost-ledger.js";

export function buildDiscoverCosts(report: DiscoverRunReport): CostEntry[] {
  const rates = costRates();
  const t = report.totals;
  const inputs: CostInput[] = [];
  const llm = (category: "llm-discover" | "llm-verify", usages: Array<{ id: string; llm: LlmUsage }>): void => {
    const calls = usages.reduce((n, u) => n + u.llm.calls, 0);
    if (!calls) return;
    inputs.push({
      category,
      usd: usages.reduce((n, u) => n + u.llm.costUsd, 0),
      estimated: false, // kwota od OpenRoutera
      units: calls,
      unit: "calls",
      tokensIn: usages.reduce((n, u) => n + u.llm.promptTokens, 0),
      tokensOut: usages.reduce((n, u) => n + u.llm.completionTokens, 0),
      drivers: usages.map((u) => ({ id: u.id, usd: u.llm.costUsd, units: u.llm.calls })),
    });
  };
  llm("llm-discover", report.towns.map((x) => ({ id: x.town, llm: x.llm })));
  llm("llm-verify", report.verifications.map((x) => ({ id: x.id, llm: x.llm })));
  inputs.push({
    category: "search",
    usd: t.searches * rates.bravePerQuery,
    estimated: true,
    units: t.searches,
    unit: "queries",
  });
  inputs.push({
    category: "scrape",
    // weryfikacja pobiera każdy URL z rejestru (plus kandydatów przy naprawie)
    usd: probeStats() * rates.scrapePerFetch,
    estimated: true,
    units: probeStats(),
    unit: "fetches",
  });
  return costEntries("discover", report.startedAt, inputs);
}

/**
 * Redakcja PII przed zapisem do PUBLICZNEGO repo. Wyniki wyszukiwarki (zwłaszcza dla zapytań
 * `site:facebook.com/groups`) niosą w opisach numery i e-maile mieszkańców — do tej pory
 * discover-runs.json omijał redakcję, którą daily.ts stosuje do runs.json.
 * URL-e zostają nietknięte (redactText wycina je z redakcji).
 */
