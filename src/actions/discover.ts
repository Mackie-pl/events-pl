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
 * Env: OPENROUTER_API_KEY (wymagany), BRAVE_API_KEY (discovery i naprawa URL-i),
 *      DISCOVER_MAX_SEARCHES (domyślnie 300 — bezpiecznik darmowego tieru 2000/mies.)
 * Brave Search API: darmowy tier 2000 zapytań/mies. Alternatywy: Serper.dev, SearXNG (0 zł).
 */
import { townsInRadius } from "../adapters/overpass.js";
import { setCallRecorder } from "../adapters/openrouter.js";
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const whyAt = args.indexOf("--why");
  if (whyAt !== -1) {
    const needle = args[whyAt + 1];
    if (!needle) {
      console.error('Użycie: npm run discover -- --why "<id | fragment URL-a | fragment nazwy>"');
      process.exitCode = 1;
      return;
    }
    explain(needle, await loadCfg("Poznań", 15), await discoverRunsStore.all());
    return;
  }

  const verifyOnly = args.includes("--verify");
  const [center = "Poznań", radiusArg = "15"] = args.filter((a) => !a.startsWith("--"));
  const radius = Number.parseInt(radiusArg, 10);
  if (!Number.isFinite(radius) || radius <= 0) {
    console.error(`Promień "${radiusArg}" nie jest dodatnią liczbą km.`);
    process.exitCode = 1;
    return;
  }

  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const report: DiscoverRunReport = {
    stage: "discover", mode: verifyOnly ? "verify" : "full",
    startedAt, finishedAt: "", durationMs: 0,
    towns: [], verifications: [], totals: emptyTotals(),
    argv: args, archiveEnabled: archiveEnabled(),
  };

  // wczytanie PRZED try: uszkodzony sources.json ma wywrócić przebieg, zanim cokolwiek nadpiszemy
  const cfg = await loadCfg(center, radius);
  const reg = buildRegistry(cfg);

  beginRun(startedAt);
  if (archiveEnabled()) {
    setCallRecorder(archiveLlmCall);
    console.log("archiwum: włączone (Supabase Storage)");
  }

  let fatal: unknown = null;
  try {
    if (!verifyOnly) {
      report.center = center;
      report.radiusKm = radius;
      const geo = await townsInRadius(center, radius);
      report.geo = geo;
      const towns = geo.towns;
      console.log(`Gminy w promieniu ${radius} km od ${center}:`, towns.join(", "));
      for (const town of towns) {
        report.towns.push(await discoverTown(town, reg, startedAt));
      }
    }

    // weryfikacja wszystkich źródeł (także świeżo dodanych — dla nich to pierwszy fetch w życiu)
    for (const src of cfg.sources) {
      const ver = await verifySource(src, reg.fresh.has(src.id));
      if (ver.outcome !== "ok" && ver.outcome !== "skipped") {
        console.log(`  ${OUTCOME_ICON[ver.outcome]} ${ver.id}: ${ver.outcome === "fixed" ? `${ver.url} → ${ver.newUrl}` : ver.err}`);
      }
      report.verifications.push(ver);
    }
  } catch (e) {
    // przebieg kosztuje realne pieniądze (Sonnet + search) — raport i zmiany w rejestrze
    // muszą przetrwać awarię, inaczej diagnoza kończy się na stack trace w logu Actions
    fatal = e;
    report.err = describeError(e);
    report.partial = true;
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - t0);
  buildTotals(report);
  report.costs = buildDiscoverCosts(report);
  redactDiscoverRun(report, cfg);

  await bootstrapSources(center, radius).save(cfg);
  await discoverRunsStore.append([report]);
  // księga kosztów przeżywa przycinanie przebiegów i łączy etap 1 z etapem 2 —
  // rachunek przychodzi jeden, więc wykres „ile dziennie" musi widzieć oba
  await recordCosts(report.costs);
  writeDiscoverSummary(report);

  const t = report.totals;
  console.log(
    `Razem źródeł: ${cfg.sources.length} (+${t.sourcesAdded}, ${t.proposalsRejected} propozycji odrzuconych) · ` +
    `weryfikacja: ✅ ${t.ok} / 🔧 ${t.fixed} / 💀 ${t.dead} / ⚠️ ${t.unrepaired} / ⏭️ ${t.skipped} · ` +
    `${t.searches} zapytań search (${t.searchErrors} błędnych, ${t.searchesSkipped} pominiętych) · ` +
    `${t.calls} LLM · koszt ${costLine(report.costs ?? [])} · ` +
    `PII: −${t.redactedPhones} tel. −${t.redactedEmails} e-mail · ${Math.round(report.durationMs / 1000)}s`,
  );
  if (archiveEnabled()) {
    const a = archiveStats();
    console.log(`archiwum: ${a.uploaded} obiektów (${(a.bytes / 1024 / 1024).toFixed(2)} MB)` + (a.failed ? `, ${a.failed} błędów` : ""));
  }
  if (t.sourcesAdded) {
    console.log(`Dlaczego dany adres wszedł na listę: npm run discover -- --why "<id źródła>"`);
  }
  if (fatal) {
    console.error(fatal);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
