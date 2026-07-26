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
import { webSearch, searchState } from "./adapters/brave.js";
import {
  MODEL_DISCOVER, chat, resetUsage, setCallRecorder, snapshotUsage,
} from "./adapters/openrouter.js";
import { townsInRadius } from "./adapters/overpass.js";
import {
  archiveEnabled, archiveLlmCall, archiveRaw, archiveStats, beginRun, beginSource, sourcePaths,
} from "./adapters/supabase-archive.js";
import { MIN_CONFIDENCE, matchHit } from "./pipeline/discover/proposal-match.js";
import { type Registry, buildRegistry, uniqueId } from "./pipeline/discover/registry.js";
import { toSource } from "./pipeline/discover/to-source.js";
import { DISCOVERY_QUERIES, DISCOVERY_SYSTEM } from "./pipeline/prompts.js";
import { verifySource } from "./pipeline/verify/verify-source.js";
import { costLine, recordCosts } from "./reporting/cost-ledger.js";
import { buildDiscoverCosts } from "./reporting/discover-costs.js";
import { discoverRunsStore } from "./reporting/discover-runs-store.js";
import { writeDiscoverSummary } from "./reporting/discover-summary.js";
import { buildTotals, emptyTotals } from "./reporting/discover-totals.js";
import { DECISION_ICON, OUTCOME_ICON } from "./reporting/icons.js";
import { redactDiscoverRun } from "./reporting/redact.js";
import { todayIso } from "./shared/dates.js";
import { describeError } from "./shared/errors.js";
import { slug, str, trim } from "./shared/text.js";
import { urlKey } from "./shared/url.js";
import { doc } from "./storage/index.js";
import type {
  DiscoverRunReport, FetchProbe, SearchResult, Source, SourceProposal, SourceProvenance,
  SourcesFile, TownDiscoveryRun,
} from "./types/index.js";


// ---------------- discovery ----------------

async function discoverTown(town: string, reg: Registry, runStartedAt: string): Promise<TownDiscoveryRun> {
  const t0 = performance.now();
  resetUsage();
  beginSource(`discover-${slug(town)}`);
  const run: TownDiscoveryRun = {
    town, searches: [], proposed: 0, added: 0, addedIds: [], proposals: [],
    llm: snapshotUsage(), ms: 0,
  };

  const finalize = (): TownDiscoveryRun => {
    run.llm = snapshotUsage();
    run.ms = Math.round(performance.now() - t0);
    const paths = sourcePaths();
    if (paths.length) run.archive = paths;
    return run;
  };

  // każdy wynik pamięta zapytanie, które go przyniosło — bez tego nie da się później
  // powiedzieć, KTÓRE zapytanie wyprodukowało dane źródło
  const hits: Array<{ query: string; result: SearchResult }> = [];
  try {
    for (const tmpl of DISCOVERY_QUERIES) {
      const query = tmpl.replace("{town}", town);
      for (const result of await webSearch(query, run.searches)) hits.push({ query, result });
    }
    if (hits.length === 0) {
      run.parse = "no-sources";
      run.err = searchState().disabled ?? "wyszukiwarka nie zwróciła żadnych wyników";
      return finalize();
    }

    // surowe wejście modelu do prywatnego archiwum — „model tego nie widział" vs
    // „widział i zignorował" to dwie różne naprawy
    await archiveRaw(`discover-${slug(town)}`, `brave://search?town=${encodeURIComponent(town)}`,
      JSON.stringify({ town, searches: run.searches }, null, 1), "search");

    const out = await chat({
      model: MODEL_DISCOVER,
      task: "discover",
      system: DISCOVERY_SYSTEM,
      user: `Miasto/gmina: ${town}\nWyniki wyszukiwania:\n${JSON.stringify(hits.map((h) => h.result))}`,
      maxTokens: 4000,
    });
    run.responseChars = out.length;

    const m = out.match(/\{[\s\S]*\}/);
    if (!m) {
      run.parse = "no-json";
      run.err = `model nie zwrócił JSON-a (${out.length} zn.)`;
      return finalize();
    }
    let raw: unknown[];
    try {
      const parsed = (JSON.parse(m[0]) as { sources?: unknown }).sources;
      raw = Array.isArray(parsed) ? parsed : [];
      run.parse = raw.length ? "ok" : "no-sources";
    } catch (e) {
      run.parse = "bad-json";
      run.err = `niepoprawny JSON od modelu: ${describeError(e)}`;
      return finalize();
    }
    run.proposed = raw.length;

    for (const item of raw) {
      const built = toSource(item, town);
      const r = item as Record<string, unknown> | null;
      const why = typeof r === "object" && r !== null ? str(r["why"]) : undefined;

      if ("err" in built) {
        run.proposals.push({
          id: (typeof r?.["id"] === "string" ? r["id"] : "?"),
          name: (typeof r?.["name"] === "string" ? r["name"] : "?"),
          url: (typeof r?.["url"] === "string" ? r["url"] : "?"),
          town, decision: "invalid", reason: built.err,
          ...(why ? { why } : {}),
        });
        continue;
      }

      const { src, fixes } = built;
      const matched = matchHit(src.url, hits);
      const proposal: SourceProposal = {
        id: src.id, name: src.name, url: src.url, town: src.town, type: src.type, fetch: src.fetch,
        decision: "added",
        ...(src.confidence !== undefined ? { confidence: src.confidence } : {}),
        ...(why ? { why } : {}),
        ...(matched ? { query: matched.query, hit: matched.hit } : {}),
      };
      run.proposals.push(proposal);

      const dupOf = reg.urls.get(urlKey(src.url));
      if (dupOf !== undefined) {
        proposal.decision = "duplicate";
        proposal.reason = `adres już w rejestrze jako "${dupOf}"`;
        continue;
      }
      if ((src.confidence ?? 0) < MIN_CONFIDENCE) {
        proposal.decision = "low-confidence";
        proposal.reason = src.confidence === undefined
          ? `brak confidence (próg ${MIN_CONFIDENCE})`
          : `confidence ${src.confidence} < ${MIN_CONFIDENCE}`;
        continue;
      }

      const id = uniqueId(src.id, reg.ids);
      if (id !== src.id) fixes.push(`id "${src.id}" zajęte → "${id}"`);
      src.id = id;
      proposal.id = id;
      if (fixes.length) proposal.reason = fixes.join("; ");

      const provenance: SourceProvenance = {
        run: runStartedAt,
        town,
        model: MODEL_DISCOVER,
        ...(matched ? { query: matched.query, hit: matched.hit } : {}),
        ...(src.confidence !== undefined ? { confidence: src.confidence } : {}),
        ...(why ? { why } : {}),
      };
      const paths = sourcePaths();
      if (paths.length) provenance.archive = paths;
      src.provenance = provenance;

      reg.cfg.sources.push(src);
      reg.urls.set(urlKey(src.url), src.id);
      reg.ids.add(src.id);
      reg.fresh.add(src.id);
      run.added++;
      run.addedIds.push(src.id);
      console.log(`  + ${town}: ${src.name} (${src.url})`);
      console.log(`      ↳ ${matched ? `"${matched.query}"` : "brak dopasowania do wyniku search"}` +
        ` · confidence ${src.confidence ?? "?"}${why ? ` · ${trim(why, 100)}` : ""}`);
    }
  } catch (e) {
    run.err = describeError(e);
  }
  return finalize();
}

// ---------------- weryfikacja / naprawa URL-i ----------------

// ---------------- --why: dlaczego ten adres jest (albo nie) w rejestrze ----------------

const fmtProbe = (p: FetchProbe): string =>
  `${p.ok ? "OK" : "PADŁ"} · HTTP ${p.httpStatus ?? "—"} · ${p.contentType ?? "?"} · ` +
  `${p.chars ?? "?"} zn. · ${p.ms} ms${p.finalUrl ? ` · przekierowanie → ${p.finalUrl}` : ""}` +
  `${p.err ? ` · ${p.err}` : ""}`;

function printProvenance(src: Source): void {
  const p = src.provenance;
  if (!p) {
    console.log("  proweniencja: BRAK — źródło dodane ręcznie albo przed wprowadzeniem śledzenia.");
    return;
  }
  console.log(`  przebieg:    ${p.run} (gmina: ${p.town})`);
  console.log(`  model:       ${p.model}${p.confidence !== undefined ? ` · confidence ${p.confidence}` : ""}`);
  if (p.why) console.log(`  dlaczego:    ${p.why}`);
  console.log(`  z zapytania: ${p.query ?? "— (brak dopasowania do wyniku wyszukiwarki)"}`);
  if (p.hit) {
    console.log(`  wynik search:`);
    console.log(`      tytuł: ${p.hit.title ?? "—"}`);
    console.log(`      url:   ${p.hit.url ?? "—"}`);
    console.log(`      opis:  ${p.hit.desc ?? "—"}`);
  }
  if (p.firstFetch) console.log(`  1. pobranie: ${fmtProbe(p.firstFetch)}`);
  if (p.archive?.length) console.log(`  archiwum:    ${p.archive.join("\n               ")}`);
}

/**
 * Odpowiada na dwa pytania naraz: „czemu ten adres tu jest?" (proweniencja + historia weryfikacji)
 * oraz „czemu tego adresu tu NIE ma?" (ledger propozycji: duplikat / niska pewność / zły rekord).
 */
function explain(needle: string, cfg: SourcesFile, runs: DiscoverRunReport[]): void {
  const q = needle.toLowerCase();
  const matches = cfg.sources.filter(
    (s) => s.id.toLowerCase() === q || s.id.toLowerCase().includes(q) ||
      s.url.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
  );

  if (matches.length === 0) console.log(`W rejestrze nie ma źródła pasującego do "${needle}".`);

  for (const src of matches) {
    console.log(`\n═══ ${src.id} — ${src.name}`);
    console.log(`  url:         ${src.url}`);
    console.log(`  gmina/typ:   ${src.town} · ${src.type} · fetch:${src.fetch}`);
    console.log(`  stan:        ${src.dead ? "💀 martwy" : src.verified ? "✅ zweryfikowany" : "niezweryfikowany"}` +
      `${src.checked ? ` (ostatnio sprawdzony ${src.checked})` : ""}${src.discovered ? ` · dodane: ${src.discovered}` : ""}`);
    if (src.notes) console.log(`  notatki:     ${src.notes}`);
    if (src.previous_urls?.length) console.log(`  stare URL-e: ${src.previous_urls.join(", ")}`);
    printProvenance(src);

    const history = runs
      .flatMap((r) => r.verifications.filter((v) => v.id === src.id).map((v) => ({ r, v })))
      .sort((a, b) => a.r.startedAt.localeCompare(b.r.startedAt));
    if (history.length) {
      console.log("  historia weryfikacji:");
      for (const { r, v } of history) {
        console.log(`      ${r.startedAt.slice(0, 10)} ${OUTCOME_ICON[v.outcome]} ${v.outcome}` +
          `${v.probe ? ` · ${fmtProbe(v.probe)}` : v.httpStatus ? ` · HTTP ${v.httpStatus}` : ""}` +
          `${v.newUrl ? ` · → ${v.newUrl}` : ""}${v.err ? ` · ${v.err}` : ""}${v.note ? ` · ${v.note}` : ""}`);
      }
    }
  }

  // propozycje (także odrzucone) — jedyne miejsce, w którym widać, czemu czegoś NIE MA na liście
  const proposals = runs.flatMap((r) =>
    r.towns.flatMap((t) =>
      t.proposals
        .filter((p) => p.id.toLowerCase().includes(q) || p.url.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .map((p) => ({ at: r.startedAt, town: t.town, p })),
    ),
  );
  if (proposals.length) {
    console.log(`\n═══ propozycje w przebiegach (${proposals.length})`);
    for (const { at, town, p } of proposals) {
      console.log(`  ${at.slice(0, 10)} ${town} ${DECISION_ICON[p.decision]} ${p.decision} — ${p.name} (${p.url})`);
      if (p.confidence !== undefined) console.log(`      confidence: ${p.confidence}`);
      if (p.why) console.log(`      dlaczego:   ${p.why}`);
      if (p.reason) console.log(`      powód:      ${p.reason}`);
      if (p.query) console.log(`      z zapytania: ${p.query}`);
    }
  } else if (matches.length === 0) {
    console.log("Żaden przebieg w discover-runs.json nie proponował takiego adresu.");
    console.log("Możliwe przyczyny: nie było go w wynikach wyszukiwarki, gmina nie była objęta discovery,");
    console.log("albo przebieg, który go rozpatrywał, wypadł już z historii (ostatnie 24).");
  }
}

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
