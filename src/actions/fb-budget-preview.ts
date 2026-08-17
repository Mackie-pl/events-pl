/**
 * PODGLĄD DECYZJI REGULATORA BUDŻETU — darmowa wyrocznia offline.
 *
 *   npm run fb-budget-preview
 *
 * Liczy dokładnie to, co policzy najbliższy `daily`: budżet z `COST_MONTHLY_BUDGET_USD`
 * minus zmierzony koszt reszty potoku, kolejkę wartości i linię cięcia. Zero sieci, zero
 * modelu, zero zapisu — czyta wyłącznie `runs.json`.
 *
 * Po co osobne wejście, skoro `daily` i tak to wypisze: bo `daily` kosztuje. Zmiana budżetu
 * albo progu ma dać się sprawdzić PRZED wydaniem pieniędzy, inaczej jedyną drogą do
 * odpowiedzi „co to zrobi" jest zapłacenie za przebieg (patrz CLAUDE.md, „pomiar przed
 * pokrętłem" i lista darmowych wyroczni).
 */
import { P } from "../config/index.js";
import { fbDailyBudget } from "../pipeline/extract/fb-budget.js";
import { applyFbMutes } from "../pipeline/extract/fb-cost-mute.js";
import { costRates } from "../reporting/cost-ledger.js";
import { buildYield } from "../reporting/source-yield.js";
import { todayIso } from "../shared/dates.js";
import { collection, stateStore } from "../storage/index.js";
import type { RunReport } from "../types/index.js";

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

async function main(): Promise<void> {
  const runs = await collection<RunReport>("runs", { at: (r) => r.startedAt }).all();
  const rep = buildYield(runs, costRates());
  const nonFbDaily = rep.sources
    .filter((s) => s.channel === "web")
    .reduce((n, s) => n + s.costUsd, 0) / Math.max(1, rep.runs);
  const monthly = P.COST_MONTHLY_BUDGET_USD.get();
  const budget = fbDailyBudget(monthly, nonFbDaily);

  console.log(`okno: ${rep.from} … ${rep.to} (${rep.runs} przebiegów)`);
  console.log(
    `budżet miesięczny $${monthly} = $${(monthly / 30).toFixed(4)}/dobę`
    + ` · reszta potoku bierze $${nonFbDaily.toFixed(4)}/dobę`
    + ` → na kanał FB zostaje $${budget.toFixed(4)}/dobę ($${(budget * 30).toFixed(2)}/mies.)\n`,
  );

  // stan jest KOPIĄ na ten podgląd i nigdzie nie wraca — nic się nie zapisuje
  const state = await stateStore.load();
  const rows = applyFbMutes(rep.sources, state, todayIso(), budget);

  console.log(
    pad("źródło", 34) + pad("gmina", 13) + "poz.".padStart(5) + "$/pobr.".padStart(9)
    + "nowe".padStart(6) + "$/nowe".padStart(9) + "  werdykt",
  );
  const order = ["keep", "town-floor", "probation", "muted", "over-ceiling", "too-few-runs"];
  for (const r of [...rows].sort((a, b) =>
    order.indexOf(a.verdict) - order.indexOf(b.verdict) || (a.rank ?? 999) - (b.rank ?? 999))) {
    // `~` znaczy SZACUNEK z sufitu limitu — źródło nigdy niepobierane nie ma pomiaru
    const perFetch = (r.usdPerFetch ?? 0).toFixed(4) + (r.fetchedRuns ? " " : "~");
    console.log(
      pad(r.id, 34) + pad(rowTown(rep, r.id), 13)
      + String(r.rank ?? "—").padStart(5)
      + perFetch.padStart(9)
      + String(r.novel).padStart(6)
      + (r.usdPerNovel === undefined ? "—" : r.usdPerNovel.toFixed(4)).padStart(9)
      + "  " + r.verdict,
    );
  }

  const FETCHING = new Set(["keep", "town-floor", "probation"]);
  const kept = rows.filter((r) => FETCHING.has(r.verdict));
  const spend = kept.reduce((n, r) => n + (r.usdPerFetch ?? 0), 0);
  console.log(
    `\npobieranych źródeł: ${kept.length} (w tym ${rows.filter((r) => r.verdict === "probation").length}`
    + ` na pasie pomiarowym) · szacowany wydatek $${spend.toFixed(4)}/dobę `
    + `= $${(spend * 30).toFixed(2)}/mies.`,
  );
  console.log("Nic nie zapisano — to podgląd.");
}

const rowTown = (rep: ReturnType<typeof buildYield>, id: string): string =>
  rep.sources.find((s) => s.id === id)?.town ?? "";

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
