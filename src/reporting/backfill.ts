/**
 * Odtworzenie wpisów księgi z raportów przebiegów, które już leżą w repo.
 *
 * Ograniczenie wpisane w dane, nie w kod: przebiegi sprzed podziału na zadania (`LlmTask`)
 * nie wiedzą, ile kosztowały plakaty. Ich koszt LLM ląduje w całości w `llm-extract`
 * z flagą `inferred: true` — kwota jest prawdziwa, przypisanie kategorii to rekonstrukcja.
 */
import type { CostDriver, CostEntry, DiscoverRunReport, RunReport } from "../types/index.js";

import { type CostInput, costEntries, costRates } from "./cost-ledger.js";

/** Etap 2. Rozbicie na zadania mają tylko nowe przebiegi; starsze idą jako `inferred`. */
export function dailyCosts(r: RunReport): CostEntry[] {
  const rates = costRates();
  const inputs: CostInput[] = [];
  const hasTasks = r.sources.some((s) => s.llmByTask);

  if (hasTasks) {
    for (const [task, category] of [["extract", "llm-extract"], ["poster", "llm-vision"]] as const) {
      const rows = r.sources
        .map((s) => ({ id: s.id, u: s.llmByTask?.[task] }))
        .filter((x): x is { id: string; u: NonNullable<typeof x.u> } => Boolean(x.u?.calls));
      if (!rows.length) continue;
      inputs.push({
        category,
        usd: rows.reduce((n, x) => n + x.u.costUsd, 0),
        estimated: false,
        units: rows.reduce((n, x) => n + x.u.calls, 0),
        unit: "calls",
        tokensIn: rows.reduce((n, x) => n + x.u.promptTokens, 0),
        tokensOut: rows.reduce((n, x) => n + x.u.completionTokens, 0),
        drivers: rows.map((x) => ({ id: x.id, usd: x.u.costUsd, units: x.u.calls })),
      });
    }
  } else if (r.totals.calls) {
    inputs.push({
      category: "llm-extract",
      usd: r.totals.costUsd,
      estimated: false,
      inferred: true, // plakaty siedzą tu razem z tekstem — stary raport ich nie rozdzielał
      units: r.totals.calls,
      unit: "calls",
      tokensIn: r.totals.promptTokens,
      tokensOut: r.totals.completionTokens,
      drivers: r.sources
        .filter((s) => s.llm.calls)
        .map((s) => ({ id: s.id, usd: s.llm.costUsd, units: s.llm.calls })),
    });
  }

  const bd = r.brightdata;
  if (bd?.records) {
    inputs.push({
      category: "fb",
      usd: bd.records * rates.bdPerRecord,
      estimated: true,
      units: bd.records,
      unit: "records",
      drivers: r.sources
        .filter((s) => s.bd?.records)
        .map((s) => ({ id: s.id, usd: (s.bd?.records ?? 0) * rates.bdPerRecord, units: s.bd?.records ?? 0 })),
    });
  }
  // wolumen sieciowy przed tą zmianą nie był liczony — nie zgadujemy go z liczby źródeł,
  // bo followupy i fallback headless potrafią go podwoić
  return costEntries("daily", r.startedAt, inputs, r.finishedAt || r.startedAt);
}

/** Etap 1. Podział discovery/verify istniał od początku (`costDiscoveryUsd` / `costVerifyUsd`). */
export function discoverCosts(r: DiscoverRunReport): CostEntry[] {
  const rates = costRates();
  const inputs: CostInput[] = [];
  const towns = r.towns ?? [];
  const vers = r.verifications ?? [];

  const push = (
    category: "llm-discover" | "llm-verify",
    rows: Array<{
      id: string;
      llm: { calls: number; promptTokens: number; completionTokens: number; costUsd: number };
    }>,
  ): void => {
    const calls = rows.reduce((n, x) => n + x.llm.calls, 0);
    if (!calls) return;
    const drivers: CostDriver[] = rows.map((x) => ({ id: x.id, usd: x.llm.costUsd, units: x.llm.calls }));
    inputs.push({
      category,
      usd: rows.reduce((n, x) => n + x.llm.costUsd, 0),
      estimated: false,
      units: calls,
      unit: "calls",
      tokensIn: rows.reduce((n, x) => n + x.llm.promptTokens, 0),
      tokensOut: rows.reduce((n, x) => n + x.llm.completionTokens, 0),
      drivers,
    });
  };
  push("llm-discover", towns.map((t) => ({ id: t.town, llm: t.llm })));
  push("llm-verify", vers.map((v) => ({ id: v.id, llm: v.llm })));

  if (r.totals.searches) {
    inputs.push({
      category: "search",
      usd: r.totals.searches * rates.searchPerQuery,
      estimated: true,
      units: r.totals.searches,
      unit: "queries",
    });
  }
  // weryfikacja pobiera po jednym URL-u na źródło; kandydaci przy naprawie są nie do odtworzenia,
  // więc to dolna granica — ale bez niej przebieg --verify znika z księgi bez śladu
  const fetches = vers.filter((v) => v.outcome !== "skipped").length;
  if (fetches) {
    inputs.push({
      category: "scrape",
      usd: fetches * rates.scrapePerFetch,
      estimated: true,
      inferred: true,
      units: fetches,
      unit: "fetches",
    });
  }
  return costEntries("discover", r.startedAt, inputs, r.finishedAt || r.startedAt);
}
