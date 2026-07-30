/**
 * Stage 1: discovery źródeł + miesięczna weryfikacja/naprawa URL-i.
 *
 * Tryby:
 *   npm run discover -- "Poznań" 15   pełne discovery (drogie: Sonnet + search) + weryfikacja
 *   npm run discover -- --verify      tylko weryfikacja/naprawa URL-i z sources.json (tanie: Haiku)
 *   npm run discover -- --why <id|url|fragment nazwy>   dlaczego ten adres jest (albo go nie ma) w rejestrze
 *
 * Weryfikacja: każdy URL jest fetchowany; martwy próbujemy naprawić (Brave search + LLM).
 * Naprawiony: stary adres ląduje w previous_urls. Nienaprawialny: dead:true + notatka
 * (daily pomija takie źródła jako "skipped-dead" aż do skutecznej naprawy w kolejnym miesiącu).
 *
 * Obserwowalność — dwa poziomy, bo odpowiadają na różne pytania:
 *   discover-runs.json  przebieg: każde zapytanie + wyniki, KAŻDA propozycja modelu wraz z decyzją
 *                       (także odrzucenia), geo, tokeny/koszt per gmina/źródło/typ zadania,
 *   sources.json        proweniencja przy samym źródle (`provenance`): zapytanie → wynik wyszukiwarki
 *                       → uzasadnienie modelu → pierwszy fetch. Przeżywa przycinanie przebiegów,
 *                       więc „czemu ten adres tu jest?" da się odpowiedzieć po latach.
 * Pełne prompty/odpowiedzi modelu idą do prywatnego archiwum (SUPABASE_*), nie do repo.
 *
 * Env: OPENROUTER_API_KEY (wymagany), GOOGLE_API_KEY + GOOGLE_CSE_CX (discovery i naprawa URL-i),
 *      DISCOVER_MAX_SEARCHES (domyślnie 300 — bezpiecznik limitu wyszukiwarki)
 * Google Programmable Search: 100 zapytań/dzień gratis, dalej $5/1000. `SEARCH_PROVIDER=brave`
 * przełącza na Brave (2000/mies. gratis, ale słabo indeksuje małe instytucje).
 */
import { townsInRadius } from "../adapters/overpass.js";
import { setCallRecorder } from "../adapters/openrouter.js";
import { searchProvider } from "../adapters/search.js";
import {
  archiveEnabled, archiveLlmCall, archiveStats, beginRun,
} from "../adapters/supabase-archive.js";
import { discoverTown } from "../pipeline/discover/discover-town.js";
import { explain } from "../pipeline/discover/explain.js";
import { buildRegistry } from "../pipeline/discover/registry.js";
import { verifySource } from "../pipeline/verify/verify-source.js";
import { costLine, recordCosts } from "../reporting/cost-ledger.js";
import { buildDiscoverCosts } from "../reporting/discover-costs.js";
import { discoverRunsStore } from "../reporting/discover-runs-store.js";
import { writeDiscoverSummary } from "../reporting/discover-summary.js";
import { buildTotals, emptyTotals } from "../reporting/discover-totals.js";
import { OUTCOME_ICON } from "../reporting/icons.js";
import { redactDiscoverRun } from "../reporting/redact.js";
import { todayIso } from "../shared/dates.js";
import { describeError } from "../shared/errors.js";
import { doc } from "../storage/index.js";
import type { DiscoverRunReport, SourcesFile } from "../types/index.js";


// ---------------- main ----------------

/**
 * Własne wiązanie rejestru, a nie współdzielony `sourcesStore`: discover jako jedyny
 * TWORZY sources.json, więc brak pliku jest dla niego stanem początkowym. Dla daily
 * i digestu ten sam brak to awaria i tam store słusznie rzuca.
 */
const bootstrapSources = (center: string, radius: number) =>
  doc<SourcesFile>("sources", () => ({
    region: {
      name: `${center} +${radius}km`, center: { lat: 0, lon: 0 }, radius_km: radius,
      discovered_at: todayIso(), discovery_method: "discover.ts",
    },
    sources: [],
  }));

const loadCfg = (center: string, radius: number): Promise<SourcesFile> =>
  bootstrapSources(center, radius).load();

type Args =
  | { mode: "why"; needle: string }
  | { mode: "run"; verifyOnly: boolean; center: string; radius: number }
  | { mode: "usage"; err: string };

/** Rozbiór argv. Wydzielony, żeby walidacja dała się przeczytać (i przetestować) bez sieci. */
export function parseArgs(args: readonly string[]): Args {
  const whyAt = args.indexOf("--why");
  if (whyAt !== -1) {
    const needle = args[whyAt + 1];
    return needle
      ? { mode: "why", needle }
      : { mode: "usage", err: 'Użycie: npm run discover -- --why "<id | fragment URL-a | fragment nazwy>"' };
  }
  const [center = "Poznań", radiusArg = "15"] = args.filter((a) => !a.startsWith("--"));
  const radius = Number.parseInt(radiusArg, 10);
  if (!Number.isFinite(radius) || radius <= 0) {
    return { mode: "usage", err: `Promień "${radiusArg}" nie jest dodatnią liczbą km.` };
  }
  return { mode: "run", verifyOnly: args.includes("--verify"), center, radius };
}

/** Właściwa praca przebiegu: discovery gmin (opcjonalne) + weryfikacja całego rejestru. */
async function runStages(
  report: DiscoverRunReport, cfg: SourcesFile, reg: ReturnType<typeof buildRegistry>,
  opts: { verifyOnly: boolean; center: string; radius: number; startedAt: string },
): Promise<void> {
  if (!opts.verifyOnly) {
    report.center = opts.center;
    report.radiusKm = opts.radius;
    const geo = await townsInRadius(opts.center, opts.radius);
    report.geo = geo;
    console.log(`Gminy w promieniu ${opts.radius} km od ${opts.center}:`, geo.towns.join(", "));
    for (const town of geo.towns) {
      report.towns.push(await discoverTown(town, reg, opts.startedAt));
    }
  }
  // weryfikacja wszystkich źródeł (także świeżo dodanych — dla nich to pierwszy fetch w życiu)
  for (const src of cfg.sources) {
    const ver = await verifySource(src, reg.fresh.has(src.id));
    if (ver.outcome !== "ok" && ver.outcome !== "skipped") {
      const detail = ver.outcome === "fixed" ? `${ver.url} → ${ver.newUrl}` : ver.err;
      console.log(`  ${OUTCOME_ICON[ver.outcome]} ${ver.id}: ${detail}`);
    }
    report.verifications.push(ver);
  }
}

/** Domknięcie raportu i zapisy. Woła się TAKŻE po awarii — patrz komentarz przy `catch`. */
async function persist(report: DiscoverRunReport, cfg: SourcesFile, center: string, radius: number): Promise<void> {
  buildTotals(report);
  report.costs = buildDiscoverCosts(report);
  redactDiscoverRun(report, cfg);

  await bootstrapSources(center, radius).save(cfg);
  await discoverRunsStore.append([report]);
  // księga kosztów przeżywa przycinanie przebiegów i łączy etap 1 z etapem 2 —
  // rachunek przychodzi jeden, więc wykres „ile dziennie" musi widzieć oba
  await recordCosts(report.costs);
  writeDiscoverSummary(report);
}

function printSummary(report: DiscoverRunReport, sources: number): void {
  const t = report.totals;
  console.log(
    `Razem źródeł: ${sources} (+${t.sourcesAdded}, ${t.proposalsRejected} propozycji odrzuconych) · ` +
    `weryfikacja: ✅ ${t.ok} / 🔧 ${t.fixed} / 💀 ${t.dead} / ⚠️ ${t.unrepaired} / ⏭️ ${t.skipped} · ` +
    `${t.searches} zapytań ${searchProvider()} (${t.searchErrors} błędnych, ${t.searchesSkipped} pominiętych) · ` +
    `${t.calls} LLM · koszt ${costLine(report.costs ?? [])} · ` +
    `PII: −${t.redactedPhones} tel. −${t.redactedEmails} e-mail · ${Math.round(report.durationMs / 1000)}s`,
  );
  if (archiveEnabled()) {
    const a = archiveStats();
    console.log(
      `archiwum: ${a.uploaded} obiektów (${(a.bytes / 1024 / 1024).toFixed(2)} MB)` +
      (a.failed ? `, ${a.failed} błędów` : ""),
    );
  }
  if (t.sourcesAdded) {
    console.log(`Dlaczego dany adres wszedł na listę: npm run discover -- --why "<id źródła>"`);
  }
}

const newReport = (startedAt: string, verifyOnly: boolean, argv: string[]): DiscoverRunReport => ({
  stage: "discover", mode: verifyOnly ? "verify" : "full",
  startedAt, finishedAt: "", durationMs: 0,
  towns: [], verifications: [], totals: emptyTotals(),
  argv, archiveEnabled: archiveEnabled(),
});

/** Wspólny start przebiegu: znacznik dla archiwum i podpięcie rejestratora wywołań LLM. */
function startRun(startedAt: string): void {
  beginRun(startedAt);
  if (archiveEnabled()) {
    setCallRecorder(archiveLlmCall);
    console.log("archiwum: włączone (Supabase Storage)");
  }
}

async function runDiscovery(
  args: Extract<Args, { mode: "run" }>, argv: string[],
): Promise<void> {
  const { center, radius, verifyOnly } = args;
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const report = newReport(startedAt, verifyOnly, argv);

  // wczytanie PRZED try: uszkodzony sources.json ma wywrócić przebieg, zanim cokolwiek nadpiszemy
  const cfg = await loadCfg(center, radius);
  const reg = buildRegistry(cfg);

  startRun(startedAt);

  let fatal: unknown = null;
  try {
    await runStages(report, cfg, reg, { verifyOnly, center, radius, startedAt });
  } catch (e) {
    // przebieg kosztuje realne pieniądze (Sonnet + search) — raport i zmiany w rejestrze
    // muszą przetrwać awarię, inaczej diagnoza kończy się na stack trace w logu Actions
    fatal = e;
    report.err = describeError(e);
    report.partial = true;
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - t0);
  await persist(report, cfg, center, radius);
  printSummary(report, cfg.sources.length);

  if (fatal) {
    console.error(fatal);
    process.exitCode = 1;
  }
}

/** Rozdzielacz trybów. Cała praca siedzi w `runDiscovery` — tu zostaje sam wybór ścieżki. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.mode === "usage") {
    console.error(args.err);
    process.exitCode = 1;
    return;
  }
  if (args.mode === "why") {
    explain(args.needle, await loadCfg("Poznań", 15), await discoverRunsStore.all());
    return;
  }
  await runDiscovery(args, argv);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
