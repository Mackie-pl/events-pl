/**
 * SONDA FANPAGE'ÓW FB — jednorazowy pomiar, nie nowy element przebiegu.
 *
 *   npm run probe-fb-pages              plan: kogo sondować i za ile (DARMOWE, nic nie pobiera)
 *   npm run probe-fb-pages -- --go      wykonaj sondę (PŁATNE — rekordy Bright Data)
 *   npm run probe-fb-pages -- --go --only=id1,id2
 *   npm run probe-fb-pages -- --go --all        także fanpage'e uznane za `covered`
 *
 * DLACZEGO PLAN JEST DOMYŚLNY, a wydatek wymaga `--go`: to jedyne miejsce w repo, które
 * kupuje rekordy W PĘTLI PO ŹRÓDŁACH. Dokładnie ten kształt kosztował $8 w jedną noc
 * 2026-08-10 (patrz adapters/brightdata.ts). Odwrócenie domyślnej odpowiedzi kosztuje jedno
 * dopisane słowo, a chroni przed przebiegiem, którego nikt nie zamawiał.
 *
 * NIC NIE ZAPISUJE POZA WŁASNYM RAPORTEM. Idzie przez `probeSource`, którego nienaruszalną
 * zasadą jest brak zapisu (events.json, state.json, runs.json, costs.json zostają nietknięte).
 * Efektem jest `fb-pages.json` + tabela na stdout. To pomiar do podjęcia decyzji, a nie
 * zmiana potoku: jeśli fanpage'e wygrają, osobną decyzją będzie wpuszczenie ich do daily.
 *
 * Rachunek za tę sondę NIE trafia do costs.json — świadomie. Księga kosztów opisuje
 * powtarzalny wydatek przebiegów, a jednorazowy pomiar wpisany do niej zafałszowałby
 * średnią dzienną i progi, które się z niej liczą.
 */
import { P } from "../config/index.js";
import { bdEnabled } from "../adapters/brightdata.js";
import {
  FB_PAGE_DATASET_MISSING, fbPageBudget, fbPageDatasetReady, fbPageLimit,
} from "../pipeline/extract/fb-page.js";
import { ProbeError, probeSource } from "../pipeline/extract/probe-source.js";
import type { FbPageCandidate } from "../reporting/fb-page-candidates.js";
import { classifyFbPages, toProbe } from "../reporting/fb-page-candidates.js";
import type { Baseline, FbPageResult, FbPagesReport } from "../reporting/fb-page-probe.js";
import { buildBaseline, planBudget, scorePage } from "../reporting/fb-page-probe.js";
import { buildYield } from "../reporting/source-yield.js";
import { describeError } from "../shared/errors.js";
import { collection, doc, eventsStore, sourcesStore } from "../storage/index.js";
import type { CostRates, RunReport } from "../types/index.js";

const fbPagesStore = doc<FbPagesReport>("fb-pages", () => {
  throw new Error("Sonda nie została jeszcze uruchomiona");
});

const rates = (): CostRates => ({
  bdPerRecord: P.BD_COST_PER_RECORD.get(),
  searchPerQuery: P.SEARCH_COST_PER_QUERY.get(),
  storagePerGbMonth: P.SUPABASE_COST_PER_GB_MONTH.get(),
  scrapePerFetch: P.SCRAPE_COST_PER_FETCH.get(),
  monthlyBudgetUsd: P.COST_MONTHLY_BUDGET_USD.get(),
});

interface Args { go: boolean; all: boolean; only: string[] }

function parseArgs(argv: readonly string[]): Args {
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "";
  return {
    go: argv.includes("--go"),
    all: argv.includes("--all"),
    only: only.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function printPlan(all: FbPageCandidate[], chosen: FbPageCandidate[], planned: number): void {
  console.log(`\nFanpage'e w rejestrze: ${all.length}\n`);
  for (const c of all) {
    const mark = chosen.some((x) => x.id === c.id) ? "→" : " ";
    console.log(`${mark} ${pad(c.bucket, 11)} ${pad(c.town, 13)} ${pad(c.id, 30)} ${c.why}`);
  }
  const usd = planned * P.BD_COST_PER_RECORD.get();
  console.log(
    `\nDo sondy: ${chosen.length} · limit ${fbPageLimit()} rek./fanpage · `
    + `plan ${planned} rekordów ≈ $${usd.toFixed(2)} (sufit ${fbPageBudget()})`,
  );
}

/** Jedno źródło: sonda + rachunek. Błąd nie przerywa całości — kończy tę jedną pozycję. */
async function probeOne(
  c: FbPageCandidate, baseline: Baseline, bdPerRecord: number,
): Promise<FbPageResult> {
  const meta = { id: c.id, name: c.name, town: c.town, url: c.url, bucket: c.bucket };
  try {
    // `force`, bo cache ekstrakcji mógłby oddać wynik bez pobrania — a sonda ma zmierzyć,
    // ile ten fanpage NAPRAWDĘ daje, nie ile zostało po kimś w state.json
    const r = await probeSource(c.id, { force: true });
    return scorePage({ meta, run: r.run, events: r.events, baseline, bdPerRecord });
  } catch (e) {
    const err = e instanceof ProbeError ? e.message : describeError(e);
    return {
      ...meta, status: "error", records: 0, posts: 0, atLimit: false,
      events: 0, novel: 0, alsoInGroups: 0, bdUsd: 0, llmUsd: 0, costUsd: 0, titles: [], err,
    };
  }
}

function printResults(report: FbPagesReport): void {
  console.log(
    `\n${pad("fanpage", 30)}${pad("gmina", 13)}${"rek.".padStart(6)}${"posty".padStart(7)}`
    + `${"wyd.".padStart(6)}${"nowe".padStart(6)}${"z grup".padStart(8)}`
    + `${"$".padStart(8)}${"$/nowe".padStart(9)}`,
  );
  for (const p of report.pages) {
    console.log(
      pad(p.id, 30) + pad(p.town, 13)
      + String(p.records).padStart(6) + String(p.posts).padStart(7)
      + String(p.events).padStart(6) + String(p.novel).padStart(6)
      + String(p.alsoInGroups).padStart(8)
      + p.costUsd.toFixed(3).padStart(8)
      + (p.usdPerNovel === undefined ? "—" : p.usdPerNovel.toFixed(4)).padStart(9)
      + (p.atLimit ? "  [limit wyczerpany]" : "") + (p.err ? `  BŁĄD: ${p.err}` : ""),
    );
  }
  const t = report.totals;
  console.log(
    `\nRAZEM fanpage'e: ${t.records} rekordów, $${t.costUsd.toFixed(3)}, `
    + `${t.events} wydarzeń, ${t.novel} spoza stron (${t.alsoInGroups} ma już któraś z grup)`
    + (t.novel ? ` → $${(t.costUsd / t.novel).toFixed(4)} za nowe wydarzenie` : ""),
  );
  if (report.groups.length) {
    console.log("\nDla porównania — grupy FB w oknie runs.json:");
    for (const g of report.groups.slice(0, 10)) {
      console.log(
        `  ${pad(g.id, 34)}${pad(g.town, 13)}${String(g.novel).padStart(5)} nowych  `
        + `$${g.costUsd.toFixed(3)}  ${g.usdPerNovel === undefined ? "—" : `$${g.usdPerNovel.toFixed(4)}/wyd.`}`,
      );
    }
  }
  for (const p of report.pages.filter((x) => x.titles.length)) {
    console.log(`\n${p.id}:`);
    for (const t2 of p.titles) console.log(`   ${t2}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cfg, runs, events] = await Promise.all([
    sourcesStore.load(),
    collection<RunReport>("runs", { at: (r) => r.startedAt }).all(),
    eventsStore.load(),
  ]);
  const rep = buildYield(runs, rates());
  const all = classifyFbPages(cfg.sources, rep.sources);

  let chosen = args.all ? [...all] : toProbe(all);
  if (args.only.length) chosen = all.filter((c) => args.only.includes(c.id));
  if (!chosen.length) {
    console.log("Nie ma czego sondować — każdy fanpage ma działającą stronę instytucji.");
    return;
  }

  const budget = planBudget(chosen.map((c) => c.id), fbPageLimit(), fbPageBudget());
  const take = chosen.filter((c) => budget.take.includes(c.id));
  printPlan(all, take, budget.plannedRecords);
  if (budget.skipped.length) {
    console.log(`Poza sufitem ${fbPageBudget()} rekordów: ${budget.skipped.join(", ")}`);
  }

  if (!args.go) {
    console.log("\nTo był plan. Sonda pobiera płatne rekordy — uruchom z --go.");
    return;
  }
  if (!bdEnabled()) { console.error("\nBrak BRIGHTDATA_API_KEY — nie ma czym pobrać."); process.exit(1); }
  if (!fbPageDatasetReady()) { console.error(`\n${FB_PAGE_DATASET_MISSING}`); process.exit(1); }

  const baseline = buildBaseline(runs, events.events);
  const bdPerRecord = P.BD_COST_PER_RECORD.get();
  const pages: FbPageResult[] = [];
  let spent = 0;
  for (const c of take) {
    console.log(`… ${c.id}`);
    const r = await probeOne(c, baseline, bdPerRecord);
    pages.push(r);
    spent += r.records;
    // sufit sprawdzany też PO fakcie: limit_per_input jest obietnicą dostawcy, nie naszą
    if (spent >= fbPageBudget()) {
      console.log(`\nSufit ${fbPageBudget()} rekordów osiągnięty — reszta pominięta.`);
      break;
    }
  }

  const report: FbPagesReport = {
    generated: new Date().toISOString(),
    from: rep.from, to: rep.to,
    budget: {
      limitPerPage: fbPageLimit(), maxRecords: fbPageBudget(),
      plannedRecords: budget.plannedRecords, spentRecords: spent,
      skippedForBudget: budget.skipped,
    },
    pages,
    groups: rep.sources
      .filter((s) => s.fetch === "fb_group" && s.fetchedRuns > 0)
      .map((s) => ({
        id: s.id, town: s.town, novel: s.novel ?? 0, costUsd: Number(s.costUsd.toFixed(4)),
        ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: Number(s.usdPerNovel.toFixed(4)) }),
      }))
      .sort((a, b) => (a.usdPerNovel ?? Infinity) - (b.usdPerNovel ?? Infinity)),
    totals: {
      records: spent,
      costUsd: Number(pages.reduce((n, p) => n + p.costUsd, 0).toFixed(4)),
      events: pages.reduce((n, p) => n + p.events, 0),
      novel: pages.reduce((n, p) => n + p.novel, 0),
      alsoInGroups: pages.reduce((n, p) => n + p.alsoInGroups, 0),
    },
  };
  await fbPagesStore.save(report);
  printResults(report);
  console.log("\nZapisane: fb-pages.json (potok nietknięty — sonda niczego innego nie zapisuje).");
}

main().catch((e: unknown) => {
  console.error(describeError(e));
  process.exit(1);
});
