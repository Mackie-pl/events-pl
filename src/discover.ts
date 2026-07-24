/**
 * Stage 1: discovery źródeł + miesięczna weryfikacja/naprawa URL-i.
 *
 * Tryby:
 *   npm run discover -- "Poznań" 15   pełne discovery (drogie: Sonnet + search) + weryfikacja
 *   npm run discover -- --verify      tylko weryfikacja/naprawa URL-i z sources.json (tanie: Haiku)
 *
 * Weryfikacja: każdy URL jest fetchowany; martwy próbujemy naprawić (Brave search + LLM).
 * Naprawiony: stary adres ląduje w previous_urls. Nienaprawialny: dead:true + notatka
 * (daily pomija takie źródła jako "skipped-dead" aż do skutecznej naprawy w kolejnym miesiącu).
 *
 * Obserwowalność: pełny przebieg (zapytania search + wyniki, geo, tokeny/koszt LLM per
 * miasto/źródło/typ zadania) ląduje w discover-runs.json — odpowiednik runs.json dla daily.
 *
 * Env: OPENROUTER_API_KEY (wymagany), BRAVE_API_KEY (discovery i naprawa URL-i)
 * Brave Search API: darmowy tier 2000 zapytań/mies. Alternatywy: Serper.dev, SearXNG (0 zł).
 */
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { BROWSER_HEADERS, describeError, fetchUrl } from "./errors.js";
import { MODEL_DISCOVER, MODEL_EXTRACT, chat, resetUsage, snapshotUsage } from "./llm.js";
import { DISCOVERY_QUERIES, DISCOVERY_SYSTEM, REVERIFY_SYSTEM } from "./prompts.js";
import type {
  DiscoverRunReport, DiscoverTotals, GeoLookup, LlmUsage, SearchCall, SearchResult, Source,
  SourceVerification, SourcesFile, TownDiscoveryRun,
} from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_PATH = join(ROOT, "sources.json");
const DISCOVER_RUNS_PATH = join(ROOT, "discover-runs.json");
const DISCOVER_RUNS_KEEP = 24; // ~2 lata miesięcznych przebiegów

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------- zewnętrzne wywołania (logowane do raportu) ----------------

/** Gminy w promieniu — Overpass API (OSM, darmowe): admin_level 7/8 wokół miasta. */
async function townsInRadius(centerTown: string, radiusKm: number, report: DiscoverRunReport): Promise<string[]> {
  const geo: GeoLookup = { query: `Overpass: admin_level 7|8 w promieniu ${radiusKm} km od "${centerTown}"`, towns: [], ms: 0 };
  report.geo = geo;
  const t0 = performance.now();
  try {
    const q = `
      [out:json][timeout:30];
      area["name"="${centerTown}"]["boundary"="administrative"]->.c;
      ( relation["boundary"="administrative"]["admin_level"~"7|8"](around.c:${radiusKm * 1000}); );
      out tags center;`;
    const res = await fetchUrl("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: q }),
    }, 60_000);
    const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
    const names = new Set<string>([centerTown]);
    for (const el of json.elements ?? []) {
      const name = el.tags?.["name"];
      if (name) names.add(name);
    }
    geo.towns = [...names].sort();
    return geo.towns;
  } catch (e) {
    geo.err = describeError(e);
    throw e;
  } finally {
    geo.ms = Math.round(performance.now() - t0);
  }
}

/** Brave search; każde zapytanie + wyniki lądują w `log`. Błąd = pusta lista (odnotowany). */
async function webSearch(query: string, log: SearchCall[]): Promise<SearchResult[]> {
  const key = process.env["BRAVE_API_KEY"];
  if (!key) throw new Error("Brak BRAVE_API_KEY");
  const call: SearchCall = { query, results: [], ms: 0 };
  log.push(call);
  const t0 = performance.now();
  try {
    const res = await fetchUrl(
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: "8", country: "pl" })}`,
      { headers: { "X-Subscription-Token": key } },
      20_000,
      "Brave Search",
    );
    const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    call.results = (json.web?.results ?? []).map((w) => ({
      title: w.title ?? null,
      url: w.url ?? null,
      desc: w.description ?? null,
    }));
    return call.results;
  } catch (e) {
    call.err = describeError(e);
    return [];
  } finally {
    call.ms = Math.round(performance.now() - t0);
    await sleep(1_100); // darmowy tier Brave: 1 zapytanie/s
  }
}

// ---------------- discovery ----------------

async function discoverTown(town: string): Promise<{ sources: Source[]; run: TownDiscoveryRun }> {
  const t0 = performance.now();
  resetUsage();
  const run: TownDiscoveryRun = {
    town, searches: [], proposed: 0, added: 0, addedIds: [],
    llm: snapshotUsage(), ms: 0,
  };
  let sources: Source[] = [];
  try {
    const results: SearchResult[] = [];
    for (const tmpl of DISCOVERY_QUERIES) {
      results.push(...(await webSearch(tmpl.replace("{town}", town), run.searches)));
    }
    const out = await chat({
      model: MODEL_DISCOVER,
      system: DISCOVERY_SYSTEM,
      user: `Miasto/gmina: ${town}\nWyniki wyszukiwania:\n${JSON.stringify(results)}`,
      maxTokens: 4000,
    });
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        sources = (JSON.parse(m[0]) as { sources?: Source[] }).sources ?? [];
      } catch { /* niepoprawny JSON od LLM — zostaje pusta lista */ }
    }
    run.proposed = sources.length;
  } catch (e) {
    run.err = describeError(e);
  }
  run.llm = snapshotUsage();
  run.ms = Math.round(performance.now() - t0);
  return { sources, run };
}

// ---------------- weryfikacja / naprawa URL-i ----------------

/** URL "działa" = odpowiada 2xx i zwraca nietrywialną treść. */
async function checkUrl(url: string): Promise<{ ok: boolean; status?: number; err?: string }> {
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 20_000);
    if (!res.ok) return { ok: false, status: res.status, err: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length < 500) return { ok: false, status: res.status, err: `podejrzanie krótka odpowiedź (${text.length} B)` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, err: describeError(e) };
  }
}

/** Szuka aktualnego URL instytucji (Brave + tani model). null = nie znaleziono. */
async function findReplacementUrl(src: Source, ver: SourceVerification): Promise<string | null> {
  const results: SearchResult[] = [];
  for (const q of [`"${src.name}" ${src.town}`, `${src.name} ${src.town} wydarzenia`]) {
    results.push(...(await webSearch(q, ver.searches)));
  }
  if (results.length === 0) return null;
  const out = await chat({
    model: MODEL_EXTRACT,
    system: REVERIFY_SYSTEM,
    user: `Instytucja: ${src.name} (${src.town})\nStary, martwy URL: ${src.url}\nWyniki wyszukiwania:\n${JSON.stringify(results)}`,
    maxTokens: 300,
  });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const url = (JSON.parse(m[0]) as { url?: string | null }).url;
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

const normUrl = (u: string): string => u.replace(/\/+$/, "");

/** Weryfikuje URL źródła i mutuje `src` (verified/checked/url/previous_urls/dead/notes). */
async function verifySource(src: Source): Promise<SourceVerification> {
  const t0 = performance.now();
  resetUsage();
  const ver: SourceVerification = {
    id: src.id, name: src.name, town: src.town, url: src.url,
    outcome: "ok", searches: [], llm: snapshotUsage(), ms: 0,
  };
  const finalize = (): SourceVerification => {
    ver.llm = snapshotUsage();
    ver.ms = Math.round(performance.now() - t0);
    return ver;
  };

  if (src.fetch === "fb") { ver.outcome = "skipped"; return finalize(); }

  const first = await checkUrl(src.url.replace("{page}", "1"));
  if (first.status !== undefined) ver.httpStatus = first.status;
  if (first.ok) {
    src.verified = true;
    src.checked = today();
    delete src.dead;
    return finalize();
  }
  if (first.err !== undefined) ver.err = first.err;

  if (!process.env["BRAVE_API_KEY"]) {
    // bez wyszukiwarki nie próbujemy naprawy — i nie dotykamy źródła
    ver.outcome = "error";
    ver.err = `${ver.err}; brak BRAVE_API_KEY — naprawa pominięta`;
    return finalize();
  }

  const candidate = await findReplacementUrl(src, ver);
  if (candidate) ver.candidate = candidate;
  if (candidate && normUrl(candidate) !== normUrl(src.url)) {
    const second = await checkUrl(candidate);
    if (second.ok) {
      src.previous_urls = [...(src.previous_urls ?? []), src.url];
      src.url = candidate;
      src.verified = true;
      src.checked = today();
      delete src.dead;
      src.notes = `${src.notes ? src.notes + " | " : ""}URL naprawiony ${today()} (stary w previous_urls)`;
      ver.outcome = "fixed";
      ver.newUrl = candidate;
      return finalize();
    }
    ver.err = `${ver.err}; kandydat ${candidate} też padł: ${second.err}`;
  }

  // naprawa się nie udała — oznacz jako martwe (daily pominie do następnego --verify)
  if (!src.dead) src.notes = `${src.notes ? src.notes + " | " : ""}martwy URL (${today()}): ${first.err}`;
  src.dead = true;
  src.verified = false;
  src.checked = today();
  ver.outcome = "dead";
  return finalize();
}

// ---------------- raport ----------------

function emptyTotals(): DiscoverTotals {
  return {
    towns: 0, searches: 0, sourcesAdded: 0, sourcesChecked: 0,
    ok: 0, fixed: 0, dead: 0, unrepaired: 0, skipped: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    costDiscoveryUsd: 0, costVerifyUsd: 0,
  };
}

function addUsage(t: DiscoverTotals, u: LlmUsage): void {
  t.calls += u.calls;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.costUsd += u.costUsd;
}

function buildTotals(report: DiscoverRunReport): void {
  const t = report.totals;
  t.towns = report.towns.length;
  for (const town of report.towns) {
    t.searches += town.searches.length;
    t.sourcesAdded += town.added;
    t.costDiscoveryUsd += town.llm.costUsd;
    addUsage(t, town.llm);
  }
  for (const v of report.verifications) {
    t.searches += v.searches.length;
    t.sourcesChecked += v.outcome === "skipped" ? 0 : 1;
    if (v.outcome === "ok") t.ok++;
    else if (v.outcome === "fixed") t.fixed++;
    else if (v.outcome === "dead") t.dead++;
    else if (v.outcome === "error") t.unrepaired++;
    else t.skipped++;
    t.costVerifyUsd += v.llm.costUsd;
    addUsage(t, v.llm);
  }
}

async function persistRun(report: DiscoverRunReport): Promise<void> {
  const prev: DiscoverRunReport[] = existsSync(DISCOVER_RUNS_PATH)
    ? (JSON.parse(await readFile(DISCOVER_RUNS_PATH, "utf-8")) as DiscoverRunReport[])
    : [];
  await writeFile(DISCOVER_RUNS_PATH, JSON.stringify([...prev, report].slice(-DISCOVER_RUNS_KEEP), null, 1), "utf-8");
}

const OUTCOME_ICON: Record<SourceVerification["outcome"], string> = {
  ok: "✅", fixed: "🔧", dead: "💀", error: "⚠️", skipped: "⏭️",
};

/** Podsumowanie do GitHub Actions job summary (Markdown), jak writeStepSummary w daily. */
function writeStepSummary(report: DiscoverRunReport): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`## discover (${report.mode}) — ${report.startedAt}`, "");
  lines.push(
    `**${t.sourcesChecked}** zweryfikowanych · ✅ ${t.ok} ok · 🔧 ${t.fixed} naprawionych · ` +
    `💀 ${t.dead} martwych · ⚠️ ${t.unrepaired} bez próby naprawy · ${t.sourcesAdded} nowych · ` +
    `${t.searches} zapytań search · ${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `$${t.costUsd.toFixed(4)} (discovery $${t.costDiscoveryUsd.toFixed(4)} + weryfikacja $${t.costVerifyUsd.toFixed(4)}) · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  if (report.towns.length) {
    lines.push("| miasto | zapytań | propozycji | dodanych | tokeny | koszt | ms |");
    lines.push("|---|--:|--:|--:|--:|--:|--:|");
    for (const town of report.towns) {
      lines.push(
        `| ${town.town} | ${town.searches.length} | ${town.proposed} | ${town.added} | ` +
        `${town.llm.promptTokens}+${town.llm.completionTokens} | $${town.llm.costUsd.toFixed(4)} | ${town.ms} |`,
      );
    }
    lines.push("");
  }
  lines.push("| źródło | wynik | http | szczegóły | koszt |");
  lines.push("|---|---|--:|---|--:|");
  for (const v of report.verifications) {
    const detail = v.outcome === "fixed" ? `→ ${v.newUrl}` : (v.err ?? "");
    lines.push(
      `| ${v.id} | ${OUTCOME_ICON[v.outcome]} ${v.outcome} | ${v.httpStatus ?? ""} | ` +
      `${detail.replaceAll("|", "\\|").slice(0, 120)} | ${v.llm.costUsd ? "$" + v.llm.costUsd.toFixed(4) : ""} |`,
    );
  }
  lines.push("");
  appendFileSync(path, lines.join("\n") + "\n", "utf-8");
}

// ---------------- main ----------------

async function loadCfg(center: string, radius: number): Promise<SourcesFile> {
  return existsSync(SOURCES_PATH)
    ? (JSON.parse(await readFile(SOURCES_PATH, "utf-8")) as SourcesFile)
    : {
        region: {
          name: `${center} +${radius}km`, center: { lat: 0, lon: 0 }, radius_km: radius,
          discovered_at: today(), discovery_method: "discover.ts",
        },
        sources: [],
      };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const [center = "Poznań", radiusArg = "15"] = args.filter((a) => !a.startsWith("--"));
  const radius = Number.parseInt(radiusArg, 10);

  const t0 = performance.now();
  const report: DiscoverRunReport = {
    stage: "discover", mode: verifyOnly ? "verify" : "full",
    startedAt: new Date().toISOString(), finishedAt: "", durationMs: 0,
    towns: [], verifications: [], totals: emptyTotals(),
  };
  const cfg = await loadCfg(center, radius);

  if (!verifyOnly) {
    report.center = center;
    report.radiusKm = radius;
    const towns = await townsInRadius(center, radius, report);
    console.log(`Gminy w promieniu ${radius} km od ${center}:`, towns.join(", "));

    const known = new Set(cfg.sources.map((s) => normUrl(s.url)));
    for (const town of towns) {
      const { sources, run } = await discoverTown(town);
      for (const s of sources) {
        if (known.has(normUrl(s.url)) || (s.confidence ?? 0) < 0.5) continue;
        cfg.sources.push({ ...s, verified: false, discovered: "auto" });
        known.add(normUrl(s.url));
        run.added++;
        run.addedIds.push(s.id);
        console.log(`  + ${town}: ${s.name} (${s.url})`);
      }
      report.towns.push(run);
    }
  }

  // weryfikacja wszystkich źródeł (także świeżo dodanych)
  for (const src of cfg.sources) {
    const ver = await verifySource(src);
    if (ver.outcome !== "ok" && ver.outcome !== "skipped") {
      console.log(`  ${OUTCOME_ICON[ver.outcome]} ${ver.id}: ${ver.outcome === "fixed" ? `${ver.url} → ${ver.newUrl}` : ver.err}`);
    }
    report.verifications.push(ver);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - t0);
  buildTotals(report);

  await writeFile(SOURCES_PATH, JSON.stringify(cfg, null, 1), "utf-8");
  await persistRun(report);
  writeStepSummary(report);

  const t = report.totals;
  console.log(
    `Razem źródeł: ${cfg.sources.length} (+${t.sourcesAdded}) · weryfikacja: ✅ ${t.ok} / 🔧 ${t.fixed} / ` +
    `💀 ${t.dead} / ⚠️ ${t.unrepaired} · ${t.searches} zapytań search · ${t.calls} LLM ` +
    `$${t.costUsd.toFixed(4)} (disc $${t.costDiscoveryUsd.toFixed(4)} + verify $${t.costVerifyUsd.toFixed(4)}) · ` +
    `${Math.round(report.durationMs / 1000)}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
