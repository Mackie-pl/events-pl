/**
 * KTÓRE ŹRÓDŁA NIE DAJĄ WARTOŚCI, NIEZALEŻNIE OD TEGO, CZY SĄ TANIE.
 *
 * measure-reuse.ts mierzy EFEKTYWNOŚĆ cache'a (ile z dzisiejszej treści płacimy po raz drugi) —
 * ale źródło może mieć idealny cache (0% marnotrawstwa) i i tak nie dawać nic wartego uwagi,
 * bo discovery wskazało niewłaściwą stronę (patrz cusdopiewo-oferta: pojedyncza, przeterminowana
 * karta wydarzenia, cache'uje się bez zarzutu, ale strukturalnie jest martwym źródłem — realny
 * kalendarz stoi pod innym adresem tej samej domeny). Ten skrypt łapie TĘ diagnozę: niski plon
 * względem tego, ile razy źródło było realnie pobierane, licząc też przebiegi, w których model
 * został wywołany i nic nie zwrócił (to już nie tylko niska wartość, ale i realny koszt).
 *
 * Czyta wyłącznie runs.json (lokalny plik, retencja ~7 dni) — zero dodatkowych wywołań LLM,
 * zero Bright Data, zero Supabase. Świadomie krótkie okno: kod i reguły ekstrakcji zmieniają
 * się z dnia na dzień, więc sprzed tygodnia dane i tak nie mówią nic pewnego o dzisiejszym kodzie.
 *
 *   npm run source-yield
 *   npm run source-yield -- --dry   # policz i wypisz, ale nie zapisuj yield.json
 */
import { collection, doc } from "../storage/index.js";
import type { RunReport, SourceRun, YieldReport, YieldSource } from "../types/index.js";

const FETCHED_STATUSES = new Set<SourceRun["status"]>(["ok", "unchanged", "error", "empty"]);

type Row = YieldSource;

function aggregate(reports: RunReport[]): Row[] {
  const byId = new Map<string, Row>();
  for (const r of reports) {
    if (r.stage !== "daily") continue;
    for (const s of r.sources) {
      if (!FETCHED_STATUSES.has(s.status)) continue; // skipped-* to świadome pominięcie, nie próba
      const row = byId.get(s.id) ?? {
        id: s.id, runs: 0, events: 0, costUsd: 0, zeroYieldCostUsd: 0, zeroYieldRuns: 0,
        emptyRuns: 0, errorRuns: 0,
      };
      row.runs += 1;
      row.events += s.events;
      row.costUsd += s.llm.costUsd;
      if (s.llm.calls > 0 && s.events === 0) {
        row.zeroYieldCostUsd += s.llm.costUsd;
        row.zeroYieldRuns += 1;
      }
      if (s.status === "empty") row.emptyRuns += 1;
      if (s.status === "error") row.errorRuns += 1;
      byId.set(s.id, row);
    }
  }
  return [...byId.values()];
}

/** Płatne i zawsze puste mimo ≥2 pobrań. Darmowe źródło bywa puste bez problemu (RSS bez ruchu). */
const chronicOf = (rows: Row[]): Row[] =>
  rows.filter((r) => r.runs >= 2 && r.events === 0 && r.costUsd > 0);

function printReport(report: YieldReport): void {
  const { sources: rows, totals } = report;
  console.log(`Okno: ${report.from} … ${report.to} (${rows.length} źródeł z co najmniej jednym realnym pobraniem)\n`);
  console.log(
    "źródło".padEnd(30) + "przeb.".padStart(7) + "wyd.".padStart(6) + "wyd./przeb.".padStart(12) +
    "koszt$".padStart(9) + "$ za nic".padStart(9) + "puste".padStart(7),
  );
  for (const r of rows) {
    const avg = r.runs ? r.events / r.runs : 0;
    console.log(
      r.id.slice(0, 29).padEnd(30) + String(r.runs).padStart(7) + String(r.events).padStart(6) +
      avg.toFixed(2).padStart(12) + r.costUsd.toFixed(3).padStart(9) +
      r.zeroYieldCostUsd.toFixed(3).padStart(9) + `${r.emptyRuns}/${r.runs}`.padStart(7),
    );
  }
  console.log(
    `\n$ zapłacone za przebiegi z 0 wydarzeń (model wywołany, nic nie wrócił): ` +
    `$${totals.wastedUsd.toFixed(3)}\n` +
    `źródła płatne i zawsze puste mimo ≥2 realnych pobrań (kandydaci do poprawy discovery): ` +
    `${totals.chronic.length ? totals.chronic.join(", ") : "brak"}`,
  );
}

async function main(): Promise<void> {
  const reports = await collection<RunReport>("runs", { at: (r) => r.startedAt }).all();
  const daily = reports.filter((r) => r.stage === "daily");
  if (!daily.length) {
    console.log("runs.json puste — brak przebiegów daily do analizy.");
    return;
  }
  const rows = aggregate(daily);
  // marnotrawstwo najpierw ($ za 0 wydarzeń), potem najniższy plon na przebieg
  rows.sort((a, b) => b.zeroYieldCostUsd - a.zeroYieldCostUsd
    || (a.events / a.runs) - (b.events / b.runs));

  const report: YieldReport = {
    generated: new Date().toISOString(),
    from: daily[0]!.startedAt.slice(0, 10),
    to: daily.at(-1)!.startedAt.slice(0, 10),
    totals: {
      sources: rows.length,
      wastedUsd: rows.reduce((a, r) => a + r.zeroYieldCostUsd, 0),
      chronic: chronicOf(rows).map((r) => r.id),
    },
    sources: rows,
  };
  printReport(report);

  if (process.argv.includes("--dry")) {
    console.log("\n--dry: nic nie zapisano.");
    return;
  }
  await doc<YieldReport>("yield", () => report).save(report);
  console.log(`\nZapisano yield.json (${rows.length} źródeł). Panel: zakładka Yield.`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
