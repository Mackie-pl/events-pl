/**
 * Odtworzenie księgi kosztów z raportów przebiegów, które już leżą w repo
 * (`runs.json`, `discover-runs.json`). Bez tego wykres wydatków startuje pusty
 * i pierwszą odpowiedź na „dlaczego drożej?" dałoby się dostać dopiero po tygodniu.
 *
 *   npm run backfill-costs             # dopisuje brakujące przebiegi
 *   npm run backfill-costs -- --force  # nadpisuje także te już w księdze
 */
import { costLine, loadCostEntries, recordCosts } from "../reporting/cost-ledger.js";
import { dailyCosts, discoverCosts } from "../reporting/backfill.js";
import { collection } from "../storage/index.js";
import type { CostEntry, DiscoverRunReport, RunReport } from "../types/index.js";

/**
 * Backfill CZYTA surowe raporty bez retencji — chce zobaczyć wszystko, co jest na dysku,
 * a nie to, co przetrwałoby zapis. Stąd własne wiązania zamiast store'ów z politykami.
 */
const rawRuns = collection<RunReport>("runs", { at: (r) => r.startedAt });
const rawDiscoverRuns = collection<DiscoverRunReport>("discover-runs", { at: (r) => r.startedAt });

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const known = new Set((await loadCostEntries()).map((e) => `${e.run}|${e.stage}`));

  const daily = await rawRuns.all();
  const discover = await rawDiscoverRuns.all();

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
