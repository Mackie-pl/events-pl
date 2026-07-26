/**
 * Odtworzenie księgi kosztów z raportów przebiegów, które już leżą w repo
 * (`runs.json`, `discover-runs.json`). Bez tego wykres wydatków startuje pusty
 * i pierwszą odpowiedź na „dlaczego drożej?" dałoby się dostać dopiero po tygodniu.
 *
 *   npm run backfill-costs           # dopisuje brakujące przebiegi
 *   npm run backfill-costs -- --force  # nadpisuje także te już w księdze
 *
 * Ograniczenie, którego nie da się obejść: przebiegi sprzed podziału na zadania
 * (`LlmTask`) nie wiedzą, ile kosztowały plakaty. Ich koszt LLM ląduje w całości
 * w `llm-extract` z flagą `inferred: true` — kwota jest prawdziwa, przypisanie
 * kategorii to rekonstrukcja. Panel pokazuje takie słupki z osobnym znacznikiem,
 * zamiast udawać pomiar.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type CostInput, costEntries, costLine, costRates, loadCostEntries, recordCosts } from "./reporting/cost-ledger.js";
import { ROOT } from "./shared/paths.js";
import type { CostDriver, CostEntry, DiscoverRunReport, RunReport } from "./types/index.js";

async function loadJson<T>(name: string, fallback: T): Promise<T> {
  const path = join(ROOT, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    console.warn(`${name}: nie do odczytania — pomijam`);
    return fallback;
  }
}

/** Etap 2. Rozbicie na zadania mają tylko nowe przebiegi; starsze idą jako `inferred`. */
function dailyCosts(r: RunReport): CostEntry[] {
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
function discoverCosts(r: DiscoverRunReport): CostEntry[] {
  const rates = costRates();
  const inputs: CostInput[] = [];
  const towns = r.towns ?? [];
  const vers = r.verifications ?? [];

  const push = (
    category: "llm-discover" | "llm-verify",
    rows: Array<{ id: string; llm: { calls: number; promptTokens: number; completionTokens: number; costUsd: number } }>,
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
      usd: r.totals.searches * rates.bravePerQuery,
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

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const known = new Set((await loadCostEntries()).map((e) => `${e.run}|${e.stage}`));

  const daily = await loadJson<RunReport[]>("runs.json", []);
  const discover = await loadJson<DiscoverRunReport[]>("discover-runs.json", []);

  const entries: CostEntry[] = [];
  let skipped = 0;
  for (const r of daily) {
    if (!force && known.has(`${r.startedAt}|daily`)) { skipped++; continue; }
    entries.push(...dailyCosts(r));
  }
  for (const r of discover) {
    if (!force && known.has(`${r.startedAt}|discover`)) { skipped++; continue; }
    entries.push(...discoverCosts(r));
  }

  if (!entries.length) {
    console.log(`Nic do dopisania (${skipped} przebiegów już w księdze, ${daily.length + discover.length} raportów przejrzanych).`);
    return;
  }
  await recordCosts(entries);
  const runs = new Set(entries.map((e) => e.run)).size;
  console.log(
    `Dopisano ${entries.length} pozycji z ${runs} przebiegów (${skipped} pominiętych jako już policzone): ` +
    costLine(entries),
  );
  const inferred = entries.filter((e) => e.inferred).length;
  if (inferred) {
    console.log(`  ${inferred} pozycji odtworzonych bez podziału na zadania (plakaty w "llm-extract") — panel je znaczy.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
