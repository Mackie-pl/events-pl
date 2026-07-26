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
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";

import {
  archiveEnabled, archiveLlmCall, archiveRaw, archiveStats, beginRun, beginSource, sourcePaths,
} from "./adapters/supabase-archive.js";
import { type CostInput, costEntries, costLine, costRates, recordCosts } from "./reporting/cost-ledger.js";
import { webSearch, searchState } from "./adapters/brave.js";
import { BROWSER_HEADERS, fetchUrl } from "./adapters/http.js";
import { townsInRadius } from "./adapters/overpass.js";
import { describeError } from "./shared/errors.js";
import {
  MODEL_DISCOVER, MODEL_EXTRACT, chat, resetUsage, setCallRecorder, snapshotUsage,
} from "./adapters/openrouter.js";
import { type RedactionStats, newStats, redactText } from "./pipeline/pii.js";
import { DISCOVERY_QUERIES, DISCOVERY_SYSTEM, REVERIFY_SYSTEM } from "./pipeline/prompts.js";
import { DISCOVER_RUNS_PATH, SOURCES_PATH } from "./shared/paths.js";
import { todayIso } from "./shared/dates.js";
import { slug, str, trim } from "./shared/text.js";
import { host, isFbFetch, normalizeFbGroupUrl, urlKey } from "./shared/url.js";
import type {
  CostEntry, DiscoverRunReport, DiscoverTotals, FetchProbe, FetchStrategy, LlmUsage,
  SearchCall, SearchResult, Source, SourceProposal, SourceProvenance, SourceType,
  SourceVerification, SourcesFile, TownDiscoveryRun,
} from "./types/index.js";

const DISCOVER_RUNS_KEEP = 24; // ~2 lata miesięcznych przebiegów
/**
 * Pełne szczegóły (wyniki wyszukiwarki, dopasowane trafienia) trzymamy tylko dla najnowszych
 * przebiegów — pełne discovery to ~13 gmin × 10 zapytań × 8 wyników, czyli setki kB na przebieg
 * w publicznym repo. Starsze wpisy zostają jako metryki + decyzje; „czemu to źródło tu jest"
 * i tak odpowiada `provenance` w sources.json.
 */
const DISCOVER_RUNS_DETAILED = 4;
/** Poniżej tego progu odpowiedź traktujemy jako zaślepkę/błąd, nie treść. */
const MIN_BODY_CHARS = 500;
/** Próg pewności modelu, poniżej którego propozycja nie trafia do rejestru. */
const MIN_CONFIDENCE = 0.5;

/** Pobrania HTTP przy weryfikacji URL-i (każde źródło + kandydaci przy naprawie) — wolumen do costs.json. */
let verifyFetches = 0;

// ---------------- propozycje modelu: walidacja + dopasowanie do wyniku search ----------------

const SOURCE_TYPES = new Set<string>([
  "city_portal", "culture_center", "library", "sports", "venue", "fb_page", "fb_group", "rss", "api", "pdf_program",
]);
const FETCH_STRATEGIES = new Set<string>(["plain", "headless", "pdf", "api", "fb", "fb_group", "fb_event", "rss"]);

/** Wynik wyszukiwarki, z którego pochodzi ten adres — dowód „skąd model to wziął". */
function matchHit(url: string, hits: Array<{ query: string; result: SearchResult }>): { query: string; hit: SearchResult } | null {
  const key = urlKey(url);
  const h = host(url);
  const exact = hits.find((x) => x.result.url && urlKey(x.result.url) === key);
  const prefix = hits.find((x) => x.result.url && (urlKey(x.result.url).startsWith(key) || key.startsWith(urlKey(x.result.url))));
  const sameHost = h ? hits.find((x) => x.result.url && host(x.result.url) === h) : undefined;
  const found = exact ?? prefix ?? sameHost;
  return found ? { query: found.query, hit: found.result } : null;
}


/**
 * Rekord od LLM → Source. Odpowiedź modelu jest rzutowana, nie walidowana (`as Source[]`
 * w poprzedniej wersji), a wchodzi wprost do rejestru czytanego codziennie przez daily.ts.
 * Brak `id` albo dwa źródła o tym samym `id` cicho scalają cache ekstrakcji w state.json.
 */
function toSource(raw: unknown, town: string): { src: Source; fixes: string[] } | { err: string } {
  if (typeof raw !== "object" || raw === null) return { err: "rekord nie jest obiektem" };
  const r = raw as Record<string, unknown>;
  const fixes: string[] = [];

  let url = str(r["url"]);
  if (!url) return { err: "brak pola url" };
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) {
      url = `https://${url}`;
      fixes.push("dodano schemat https://");
    } else {
      return { err: `url nie jest adresem http(s): ${trim(url, 80)}` };
    }
  }
  try {
    new URL(url.replace("{page}", "1"));
  } catch {
    return { err: `url nie do sparsowania: ${trim(url, 80)}` };
  }

  const name = str(r["name"]);
  if (!name) return { err: "brak pola name" };

  let fetchStrategy = str(r["fetch"]) ?? "";
  let type = str(r["type"]) ?? "";
  if (/facebook\.com\/groups\//i.test(url)) {
    const rooted = normalizeFbGroupUrl(url);
    if (rooted !== url) { url = rooted; fixes.push("URL grupy skrócony do korzenia"); }
    if (fetchStrategy !== "fb_group") { fetchStrategy = "fb_group"; fixes.push('fetch → "fb_group" (URL grupy FB)'); }
    if (type !== "fb_group") { type = "fb_group"; fixes.push('type → "fb_group"'); }
  } else if (/^https?:\/\/(?:www\.)?facebook\.com\//i.test(url) && fetchStrategy !== "fb") {
    fetchStrategy = "fb";
    fixes.push('fetch → "fb" (adres facebook.com)');
  }
  if (!FETCH_STRATEGIES.has(fetchStrategy)) {
    fixes.push(`nieznane fetch "${trim(fetchStrategy, 30)}" → "plain"`);
    fetchStrategy = "plain";
  }
  if (!SOURCE_TYPES.has(type)) {
    fixes.push(`nieznany type "${trim(type, 30)}" → "venue"`);
    type = "venue";
  }

  const confidence = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"])
    ? Math.max(0, Math.min(1, r["confidence"]))
    : undefined;

  const id = slug(str(r["id"]) ?? `${town}-${name}`);
  if (!id) return { err: "nie da się zbudować id" };

  const notes = str(r["notes"]);
  const src: Source = {
    id,
    name,
    type: type as SourceType,
    url,
    town: str(r["town"]) ?? town,
    fetch: fetchStrategy as FetchStrategy,
    verified: false,
    discovered: "auto",
    ...(confidence !== undefined ? { confidence } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  return { src, fixes };
}

// ---------------- rejestr (merge propozycji) ----------------

interface Registry {
  cfg: SourcesFile;
  /** urlKey wszystkich znanych adresów */
  urls: Map<string, string>; // urlKey -> id źródła
  ids: Set<string>;
  /** id dodane w TYM przebiegu — ich weryfikacja to pierwszy fetch w życiu źródła */
  fresh: Set<string>;
}

function buildRegistry(cfg: SourcesFile): Registry {
  const urls = new Map<string, string>();
  const ids = new Set<string>();
  for (const s of cfg.sources) {
    urls.set(urlKey(s.url), s.id);
    ids.add(s.id);
  }
  return { cfg, urls, ids, fresh: new Set() };
}

/** Wolne id o tym samym rdzeniu — kolizja scaliłaby cache ekstrakcji dwóch różnych stron. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

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

/**
 * Jedno żądanie z pełnym opisem odpowiedzi. Sam kod statusu nie diagnozuje: 200 z 300 bajtami
 * to zaślepka, a 200 pod innym adresem niż pytany to przekierowanie na stronę główną
 * (czyli podstrona z wydarzeniami zniknęła, choć URL „działa").
 */
async function probeUrl(url: string): Promise<FetchProbe> {
  const t0 = performance.now();
  verifyFetches += 1;
  const probe: FetchProbe = { at: new Date().toISOString(), url, ok: false, ms: 0 };
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 20_000);
    probe.httpStatus = res.status;
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim();
    if (ct) probe.contentType = ct;
    if (res.url && urlKey(res.url) !== urlKey(url)) probe.finalUrl = res.url;
    if (!res.ok) {
      probe.err = `HTTP ${res.status}`;
      return probe;
    }
    const text = await res.text();
    probe.chars = text.length;
    if (text.length < MIN_BODY_CHARS) {
      probe.err = `podejrzanie krótka odpowiedź (${text.length} B)`;
      return probe;
    }
    probe.ok = true;
    return probe;
  } catch (e) {
    probe.err = describeError(e);
    return probe;
  } finally {
    probe.ms = Math.round(performance.now() - t0);
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
    task: "verify",
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

/** Weryfikuje URL źródła i mutuje `src` (verified/checked/url/previous_urls/dead/notes). */
async function verifySource(src: Source, isNew: boolean): Promise<SourceVerification> {
  const t0 = performance.now();
  resetUsage();
  beginSource(`verify-${src.id}`);
  const ver: SourceVerification = {
    id: src.id, name: src.name, town: src.town, url: src.url,
    outcome: "ok", searches: [], llm: snapshotUsage(), ms: 0,
    ...(isNew ? { isNew: true } : {}),
  };
  const finalize = (): SourceVerification => {
    ver.llm = snapshotUsage();
    ver.ms = Math.round(performance.now() - t0);
    const paths = sourcePaths();
    if (paths.length) ver.archive = paths;
    return ver;
  };

  if (isFbFetch(src.fetch)) {
    // FB odpowiada login-wallem: 200 z treścią „zaloguj się" albo 403. Jedno i drugie
    // prowadziło do „naprawy" adresu przypadkowym wynikiem z wyszukiwarki albo do dead:true,
    // przez co daily przestawało odpytywać żywą grupę (skipped-dead).
    ver.outcome = "skipped";
    ver.note = `fetch:"${src.fetch}" — adresy FB nie odpowiadają na zwykły fetch`;
    // `checked` znaczy „URL potwierdzony jako działający tego dnia" — pominięcia nim nie znaczymy,
    // ślad zostaje w raporcie przebiegu (outcome: skipped + note)
    return finalize();
  }

  try {
    const probe = await probeUrl(src.url.replace("{page}", "1"));
    ver.probe = probe;
    if (probe.httpStatus !== undefined) ver.httpStatus = probe.httpStatus;
    if (isNew && src.provenance) src.provenance.firstFetch = probe;

    if (probe.ok) {
      src.verified = true;
      src.checked = todayIso();
      delete src.dead;
      return finalize();
    }
    ver.err = probe.err ?? "nieznany błąd";

    if (!process.env["BRAVE_API_KEY"] || searchState().disabled) {
      // bez wyszukiwarki nie próbujemy naprawy — i nie dotykamy źródła
      ver.outcome = "error";
      ver.err = `${ver.err}; ${searchState().disabled ?? "brak BRAVE_API_KEY"} — naprawa pominięta`;
      return finalize();
    }

    const candidate = await findReplacementUrl(src, ver);
    if (candidate) ver.candidate = candidate;
    if (candidate && urlKey(candidate) !== urlKey(src.url)) {
      const second = await probeUrl(candidate);
      ver.candidateProbe = second;
      if (second.ok) {
        src.previous_urls = [...(src.previous_urls ?? []), src.url];
        src.url = candidate;
        src.verified = true;
        src.checked = todayIso();
        delete src.dead;
        src.notes = `${src.notes ? src.notes + " | " : ""}URL naprawiony ${todayIso()} (stary w previous_urls)`;
        ver.outcome = "fixed";
        ver.newUrl = candidate;
        return finalize();
      }
      ver.err = `${ver.err}; kandydat ${candidate} też padł: ${second.err}`;
    }

    // naprawa się nie udała — oznacz jako martwe (daily pominie do następnego --verify)
    if (!src.dead) src.notes = `${src.notes ? src.notes + " | " : ""}martwy URL (${todayIso()}): ${probe.err}`;
    src.dead = true;
    src.verified = false;
    src.checked = todayIso();
    ver.outcome = "dead";
    return finalize();
  } catch (e) {
    // Wyjątek w naprawie (padnięty OpenRouter, timeout) nie może zabrać ze sobą reszty rejestru
    // ani tego, co już wiemy o TYM źródle: bez tego łapania ginęły jego zapytania i zużycie LLM,
    // a 45 pozostałych źródeł zostawało niesprawdzonych. Źródła nie oznaczamy — naprawa
    // nie dała odpowiedzi, więc `dead` byłoby zgadywaniem (daily przestałoby je odpytywać).
    ver.outcome = "error";
    ver.err = `${ver.err ? ver.err + "; " : ""}${describeError(e)}`;
    return finalize();
  }
}

// ---------------- raport ----------------

function emptyTotals(): DiscoverTotals {
  return {
    towns: 0, searches: 0, searchErrors: 0, searchesSkipped: 0,
    sourcesAdded: 0, proposalsRejected: 0, sourcesChecked: 0,
    ok: 0, fixed: 0, dead: 0, unrepaired: 0, skipped: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    costDiscoveryUsd: 0, costVerifyUsd: 0,
    redactedPhones: 0, redactedEmails: 0,
  };
}

function addUsage(t: DiscoverTotals, u: LlmUsage): void {
  t.calls += u.calls;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.costUsd += u.costUsd;
}

function countSearches(t: DiscoverTotals, calls: SearchCall[]): void {
  for (const c of calls) {
    if (c.skipped) continue; // niewysłane nie zużyły limitu
    t.searches++;
    if (c.err) t.searchErrors++;
  }
}

function buildTotals(report: DiscoverRunReport): void {
  const t = report.totals;
  t.towns = report.towns.length;
  t.searchesSkipped = searchState().skipped;
  for (const town of report.towns) {
    countSearches(t, town.searches);
    t.sourcesAdded += town.added;
    t.proposalsRejected += town.proposals.filter((p) => p.decision !== "added").length;
    t.costDiscoveryUsd += town.llm.costUsd;
    addUsage(t, town.llm);
  }
  for (const v of report.verifications) {
    countSearches(t, v.searches);
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

/**
 * Koszt przebiegu w rozbiciu na kategorie (costs.json). Discovery i weryfikacja to ten sam
 * rachunek w OpenRouterze, ale zupełnie różne pozycje w budżecie: pierwsza jest droga
 * i jednorazowa (Sonnet, nowe miasto), druga tania i comiesięczna (Haiku, naprawa URL-i).
 * Zapytania Brave idą osobno — darmowy tier 2000/mies. kończy się cicho, więc wolumen
 * musi być zapisany także wtedy, gdy stawka wynosi zero.
 */
function buildCosts(report: DiscoverRunReport): CostEntry[] {
  const rates = costRates();
  const t = report.totals;
  const inputs: CostInput[] = [];
  const llm = (category: "llm-discover" | "llm-verify", usages: Array<{ id: string; llm: LlmUsage }>): void => {
    const calls = usages.reduce((n, u) => n + u.llm.calls, 0);
    if (!calls) return;
    inputs.push({
      category,
      usd: usages.reduce((n, u) => n + u.llm.costUsd, 0),
      estimated: false, // kwota od OpenRoutera
      units: calls,
      unit: "calls",
      tokensIn: usages.reduce((n, u) => n + u.llm.promptTokens, 0),
      tokensOut: usages.reduce((n, u) => n + u.llm.completionTokens, 0),
      drivers: usages.map((u) => ({ id: u.id, usd: u.llm.costUsd, units: u.llm.calls })),
    });
  };
  llm("llm-discover", report.towns.map((x) => ({ id: x.town, llm: x.llm })));
  llm("llm-verify", report.verifications.map((x) => ({ id: x.id, llm: x.llm })));
  inputs.push({
    category: "search",
    usd: t.searches * rates.bravePerQuery,
    estimated: true,
    units: t.searches,
    unit: "queries",
  });
  inputs.push({
    category: "scrape",
    // weryfikacja pobiera każdy URL z rejestru (plus kandydatów przy naprawie)
    usd: verifyFetches * rates.scrapePerFetch,
    estimated: true,
    units: verifyFetches,
    unit: "fetches",
  });
  return costEntries("discover", report.startedAt, inputs);
}

/**
 * Redakcja PII przed zapisem do PUBLICZNEGO repo. Wyniki wyszukiwarki (zwłaszcza dla zapytań
 * `site:facebook.com/groups`) niosą w opisach numery i e-maile mieszkańców — do tej pory
 * discover-runs.json omijał redakcję, którą daily.ts stosuje do runs.json.
 * URL-e zostają nietknięte (redactText wycina je z redakcji).
 */
function redactRun(report: DiscoverRunReport, cfg: SourcesFile): void {
  const stats: RedactionStats = newStats();
  /** In-place, tylko dla realnych stringów — przy exactOptionalPropertyTypes nie wolno wstawić undefined. */
  const red = <T extends object, K extends keyof T>(o: T | undefined, k: K): void => {
    if (!o) return;
    const v = o[k];
    if (typeof v === "string") o[k] = redactText(v, stats) as T[K];
  };
  const redHit = (h: SearchResult | undefined): void => {
    red(h, "title");
    red(h, "desc");
  };
  const redSearches = (calls: SearchCall[]): void => {
    for (const c of calls) {
      red(c, "err");
      for (const r of c.results) redHit(r);
    }
  };

  red(report, "err");
  red(report.geo, "err");
  for (const town of report.towns) {
    red(town, "err");
    redSearches(town.searches);
    for (const p of town.proposals) {
      red(p, "name");
      red(p, "why");
      red(p, "reason");
      redHit(p.hit);
    }
  }
  for (const v of report.verifications) {
    red(v, "err");
    red(v, "note");
    redSearches(v.searches);
    red(v.probe, "err");
    red(v.candidateProbe, "err");
  }
  // sources.json też jest publiczny — proweniencja niesie opis wyniku wyszukiwarki
  for (const s of cfg.sources) {
    red(s, "notes");
    if (!s.provenance) continue;
    red(s.provenance, "why");
    redHit(s.provenance.hit);
    red(s.provenance.firstFetch, "err");
  }
  report.totals.redactedPhones = stats.phones;
  report.totals.redactedEmails = stats.emails;
}

/** Starszy przebieg bez szczegółów: zostają metryki i decyzje, znika masa wyników wyszukiwarki. */
function slim(r: DiscoverRunReport): DiscoverRunReport {
  if (r.slimmed) return r;
  const slimSearches = (calls: SearchCall[]): SearchCall[] =>
    calls.map((c) => (c.results.length ? { ...c, results: [], trimmed: c.results.length } : c));
  return {
    ...r,
    slimmed: true,
    towns: r.towns.map((t) => ({
      ...t,
      searches: slimSearches(t.searches),
      proposals: t.proposals.map(({ hit: _hit, ...p }) => p),
    })),
    verifications: r.verifications.map((v) => ({ ...v, searches: slimSearches(v.searches) })),
  };
}

/**
 * Kształt przebiegu tak, jak leży na dysku: przebiegi zapisane starszą wersją nie mają
 * `proposals` ani nowych pól. Czytamy plik z historii, więc typy z types.ts opisują tu
 * intencję, a nie gwarancję — normalizujemy przy wczytaniu, zamiast rozsypywać `?? []`.
 */
type StoredRun = Omit<DiscoverRunReport, "towns" | "verifications"> & {
  towns?: Array<Omit<TownDiscoveryRun, "searches" | "proposals"> & { searches?: SearchCall[]; proposals?: SourceProposal[] }>;
  verifications?: Array<Omit<SourceVerification, "searches"> & { searches?: SearchCall[] }>;
};

const normalizeRun = (r: StoredRun): DiscoverRunReport => ({
  ...r,
  towns: (r.towns ?? []).map((t) => ({ ...t, searches: t.searches ?? [], proposals: t.proposals ?? [] })),
  verifications: (r.verifications ?? []).map((v) => ({ ...v, searches: v.searches ?? [] })),
});

async function loadRuns(): Promise<DiscoverRunReport[]> {
  if (!existsSync(DISCOVER_RUNS_PATH)) return [];
  try {
    const parsed: unknown = JSON.parse(await readFile(DISCOVER_RUNS_PATH, "utf-8"));
    return Array.isArray(parsed) ? (parsed as StoredRun[]).map(normalizeRun) : [];
  } catch (e) {
    // uszkodzony plik historii nie może wywrócić przebiegu wartego kilku dolarów
    console.warn(`discover-runs.json nie do odczytania (${describeError(e)}) — historia zaczyna się od nowa`);
    return [];
  }
}

async function persistRun(report: DiscoverRunReport): Promise<void> {
  const kept = [...(await loadRuns()), report].slice(-DISCOVER_RUNS_KEEP);
  const out = kept.map((r, i) => (i < kept.length - DISCOVER_RUNS_DETAILED ? slim(r) : r));
  await writeFile(DISCOVER_RUNS_PATH, JSON.stringify(out, null, 1), "utf-8");
}

const OUTCOME_ICON: Record<SourceVerification["outcome"], string> = {
  ok: "✅", fixed: "🔧", dead: "💀", error: "⚠️", skipped: "⏭️",
};

const DECISION_ICON: Record<SourceProposal["decision"], string> = {
  added: "➕", duplicate: "♻️", "low-confidence": "🤏", invalid: "🚫",
};

const md = (s: string, max = 120): string => trim(s.replaceAll("|", "\\|").replace(/\s+/g, " "), max);

/** Podsumowanie do GitHub Actions job summary (Markdown), jak writeStepSummary w daily. */
function writeStepSummary(report: DiscoverRunReport): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`## discover (${report.mode}) — ${report.startedAt}`, "");
  if (report.err) lines.push(`> ⚠️ **przebieg przerwany:** ${md(report.err, 300)} — liczby są cząstkowe`, "");
  if (report.geo?.fallback) lines.push(`> ⚠️ Overpass padł (${md(report.geo.err ?? "", 200)}) — discovery tylko dla miasta centralnego`, "");
  lines.push(
    `**${t.sourcesChecked}** zweryfikowanych · ✅ ${t.ok} ok · 🔧 ${t.fixed} naprawionych · ` +
    `💀 ${t.dead} martwych · ⚠️ ${t.unrepaired} bez próby naprawy · ⏭️ ${t.skipped} pominiętych (FB) · ` +
    `${t.sourcesAdded} nowych (${t.proposalsRejected} propozycji odrzuconych) · ` +
    `${t.searches} zapytań search (${t.searchErrors} błędnych, ${t.searchesSkipped} pominiętych) · ` +
    `${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `koszt ${costLine(report.costs ?? [])} · ` +
    `🔒 ${t.redactedPhones} tel. / ${t.redactedEmails} e-mail zredagowanych · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  if (!report.archiveEnabled) {
    lines.push("> ℹ️ prywatne archiwum wyłączone (brak SUPABASE_*) — promptów modelu nie da się odtworzyć", "");
  }

  if (report.towns.length) {
    lines.push("| gmina | zapytań | odpowiedź | propozycji | dodanych | tokeny | koszt | ms |");
    lines.push("|---|--:|---|--:|--:|--:|--:|--:|");
    for (const town of report.towns) {
      // wysłane, nie „zalogowane": pominięte po wyłączeniu wyszukiwarki nie zużyły limitu
      const sent = town.searches.filter((s) => !s.skipped).length;
      const skipped = town.searches.length - sent;
      lines.push(
        `| ${town.town} | ${sent}${skipped ? ` (+${skipped} pom.)` : ""} | ` +
        `${town.parse ?? "—"}${town.err ? ` (${md(town.err, 60)})` : ""} | ` +
        `${town.proposed} | ${town.added} | ${town.llm.promptTokens}+${town.llm.completionTokens} | ` +
        `$${town.llm.costUsd.toFixed(4)} | ${town.ms} |`,
      );
    }
    lines.push("");

    // proweniencja: to jest odpowiedź na „czemu ten adres wszedł na listę"
    const proposals = report.towns.flatMap((t2) => t2.proposals.map((p) => ({ town: t2.town, p })));
    if (proposals.length) {
      lines.push("### Propozycje modelu", "");
      lines.push("| decyzja | źródło | URL | conf. | z zapytania | dlaczego / powód odrzucenia |");
      lines.push("|---|---|---|--:|---|---|");
      for (const { p } of proposals) {
        lines.push(
          `| ${DECISION_ICON[p.decision]} ${p.decision} | ${md(p.name, 40)} | ${md(p.url, 60)} | ` +
          `${p.confidence ?? ""} | ${p.query ? md(p.query, 40) : "—"} | ` +
          `${md([p.why, p.reason].filter(Boolean).join(" · ") || "—", 140)} |`,
        );
      }
      lines.push("");
    }
  }

  const fresh = report.verifications.filter((v) => v.isNew);
  if (fresh.length) {
    lines.push("### Pierwsze pobranie nowych źródeł", "");
    lines.push("| źródło | wynik | http | typ | znaków | przekierowanie | błąd |");
    lines.push("|---|---|--:|---|--:|---|---|");
    for (const v of fresh) {
      lines.push(
        `| ${v.id} | ${OUTCOME_ICON[v.outcome]} ${v.outcome} | ${v.probe?.httpStatus ?? ""} | ` +
        `${v.probe?.contentType ?? ""} | ${v.probe?.chars ?? ""} | ${v.probe?.finalUrl ? md(v.probe.finalUrl, 60) : ""} | ` +
        `${md(v.err ?? "", 80)} |`,
      );
    }
    lines.push("");
  }

  lines.push("### Weryfikacja rejestru", "");
  lines.push("| źródło | wynik | http | znaków | szczegóły | koszt |");
  lines.push("|---|---|--:|--:|---|--:|");
  for (const v of report.verifications) {
    const detail = v.outcome === "fixed" ? `→ ${v.newUrl}` : (v.err ?? v.note ?? "");
    lines.push(
      `| ${v.id} | ${OUTCOME_ICON[v.outcome]} ${v.outcome} | ${v.httpStatus ?? ""} | ${v.probe?.chars ?? ""} | ` +
      `${md(detail)} | ${v.llm.costUsd ? "$" + v.llm.costUsd.toFixed(4) : ""} |`,
    );
  }
  lines.push("");
  appendFileSync(path, lines.join("\n") + "\n", "utf-8");
}

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

async function loadCfg(center: string, radius: number): Promise<SourcesFile> {
  return existsSync(SOURCES_PATH)
    ? (JSON.parse(await readFile(SOURCES_PATH, "utf-8")) as SourcesFile)
    : {
        region: {
          name: `${center} +${radius}km`, center: { lat: 0, lon: 0 }, radius_km: radius,
          discovered_at: todayIso(), discovery_method: "discover.ts",
        },
        sources: [],
      };
}

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
    explain(needle, await loadCfg("Poznań", 15), await loadRuns());
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
  report.costs = buildCosts(report);
  redactRun(report, cfg);

  await writeFile(SOURCES_PATH, JSON.stringify(cfg, null, 1), "utf-8");
  await persistRun(report);
  // księga kosztów przeżywa przycinanie przebiegów i łączy etap 1 z etapem 2 —
  // rachunek przychodzi jeden, więc wykres „ile dziennie" musi widzieć oba
  await recordCosts(report.costs);
  writeStepSummary(report);

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
