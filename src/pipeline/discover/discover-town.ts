/** Discovery jednej gminy: zapytania do wyszukiwarki → triage modelem → wpisy do rejestru. */
import { searchState, webSearch } from "../../adapters/search.js";
import {
  MODEL_DISCOVER, chat, finishReason, resetUsage, snapshotUsage, wasTruncated,
} from "../../adapters/openrouter.js";
import { archiveRaw, beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { todayIso } from "../../shared/dates.js";
import { describeError } from "../../shared/errors.js";
import { salvageArray } from "../../shared/json-salvage.js";
import { slug, str, trim } from "../../shared/text.js";
import { urlKey } from "../../shared/url.js";
import type {
  SearchResult, Source, SourceProposal, SourceProvenance, TownDiscoveryRun,
} from "../../types/index.js";
import { DISCOVERY_QUERIES, DISCOVERY_SYSTEM } from "../prompts.js";

import { MIN_CONFIDENCE, matchHit } from "./proposal-match.js";
import { type Registry, uniqueId } from "./registry.js";
import { toSource } from "./to-source.js";

/**
 * Sufit odpowiedzi modelu na jedną gminę.
 *
 * 4000 (poprzednia wartość) wystarczało, dopóki gminy były małe. Poznań to dziesięć zapytań
 * po ~9 wyników, czyli ~94 rekordy do oceny — model uderzył w limit CO DO TOKENA i cała
 * gmina przepadła. Zależność jest przewrotna: im lepsze wyniki wyszukiwarki, tym pewniejsza
 * porażka, więc największa gmina przebiegu zawodzi pierwsza.
 *
 * 12000 daje ~3x zapasu przy obecnej liczbie zapytań. To sufit bezpieczeństwa, nie budżet:
 * płacimy za tokeny FAKTYCZNIE wygenerowane, więc małe gminy nic na tym nie tracą.
 */
const MAX_TOKENS = Number(process.env["DISCOVER_MAX_TOKENS"] ?? 12_000);

/** Kontekst potwierdzenia — te same cztery rzeczy, z których buduje się proweniencję. */
export interface Confirmation {
  run: string;
  town: string;
  matched: { query: string; hit: SearchResult } | null;
  why: string | undefined;
}

/**
 * Adres już jest w rejestrze, a wyszukiwarka właśnie go potwierdziła.
 *
 * Wcześniej ta gałąź robiła `continue` i to była jedyna reakcja: źródło nie dowiadywało się,
 * że nadal istnieje, a odpowiedź na „skąd to się tu wzięło" nigdy nie powstawała dla niczego,
 * co weszło do rejestru inaczej niż przez discovery. Stąd 46 źródeł bez proweniencji, których
 * żaden kolejny przebieg nie mógł naprawić.
 *
 * Proweniencję dopisujemy TYLKO, gdy jej nie ma — pierwotne znalezisko jest cenniejsze niż
 * dowolne późniejsze potwierdzenie i nie wolno go nadpisać.
 */
export function confirm(src: Source, proposal: SourceProposal, ctx: Confirmation): void {
  src.lastSeenRun = ctx.run;
  src.missedRuns = 0;
  if (src.inactive) {
    delete src.inactive;
    src.notes = `${src.notes ? src.notes + " | " : ""}${todayIso()}: znowu znalezione przez discovery`;
  }
  if (src.provenance) {
    proposal.decision = "duplicate";
    proposal.reason = `adres już w rejestrze jako "${src.id}" (proweniencja już jest)`;
    return;
  }
  src.provenance = {
    run: ctx.run,
    town: ctx.town,
    model: MODEL_DISCOVER,
    ...(ctx.matched ? { query: ctx.matched.query, hit: ctx.matched.hit } : {}),
    ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
    ...(ctx.why ? { why: ctx.why } : {}),
  };
  proposal.decision = "confirmed";
  proposal.reason = `w rejestrze jako "${src.id}" — dopisana proweniencja`;
}

export async function discoverTown(town: string, reg: Registry, runStartedAt: string): Promise<TownDiscoveryRun> {
  const t0 = performance.now();
  resetUsage();
  beginSource(`discover-${slug(town)}`);
  const run: TownDiscoveryRun = {
    town, searches: [], proposed: 0, added: 0, addedIds: [], confirmed: 0, proposals: [],
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
    for (const [i, tmpl] of DISCOVERY_QUERIES.entries()) {
      const query = tmpl.replace("{town}", town);
      const results = await webSearch(query, run.searches);
      for (const result of results) hits.push({ query, result });
      // przebieg spędza tu ~10 s na gminę i wcześniej nie mówił o tym nic — po podsumowaniu
      // dało się odczytać, ILE zapytań poszło, ale nigdy KTÓRE i czy jeszcze żyje
      const call = run.searches.at(-1);
      console.log(
        `  🔍 ${town} ${i + 1}/${DISCOVERY_QUERIES.length}: "${query}" — ` +
        (call?.skipped ? "pominięte" : `${results.length} wyników`) +
        `${call?.err ? ` · ${call.err}` : ""} (${call?.ms ?? 0} ms)`,
      );
    }
    if (hits.length === 0) {
      run.parse = "no-sources";
      run.err = searchState().disabled ?? "wyszukiwarka nie zwróciła żadnych wyników";
      return finalize();
    }

    // surowe wejście modelu do prywatnego archiwum — „model tego nie widział" vs
    // „widział i zignorował" to dwie różne naprawy
    await archiveRaw(`discover-${slug(town)}`, `search://web?town=${encodeURIComponent(town)}`,
      JSON.stringify({ town, searches: run.searches }, null, 1), "search");

    // najdłuższy pojedynczy krok przebiegu (Poznań: 60 s) — bez tej linii CLI milczał
    // przez minutę i nie dawało się odróżnić pracy od zawieszenia
    console.log(`  🧠 ${town}: ${MODEL_DISCOVER} ocenia ${hits.length} wyników (limit ${MAX_TOKENS} tok.)…`);
    const tLlm = performance.now();
    const out = await chat({
      model: MODEL_DISCOVER,
      task: "discover",
      system: DISCOVERY_SYSTEM,
      user: `Miasto/gmina: ${town}\nWyniki wyszukiwania:\n${JSON.stringify(hits.map((h) => h.result))}`,
      maxTokens: MAX_TOKENS,
    });
    const finish = finishReason();
    run.responseChars = out.length;
    if (finish) run.finish = finish;
    console.log(
      `  🧠 ${town}: ${out.length} zn. w ${((performance.now() - tLlm) / 1000).toFixed(1)}s` +
      ` (koniec: ${finish ?? "?"})`,
    );

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
      if (wasTruncated()) {
        // JSON się domknął, ale model i tak został przerwany — lista jest niepełna,
        // a bez ostrzeżenia wyglądałaby na kompletną odpowiedź „tyle jest w tej gminie"
        console.warn(`  ⚠️ ${town}: odpowiedź ucięta na limicie ${MAX_TOKENS} tok. — lista może być niepełna`);
      }
    } catch (e) {
      // Ucięcie psuje WYŁĄCZNIE ogon dokumentu. Kompletne rekordy sprzed miejsca przerwania
      // są w pełni dobre i nie ma powodu wyrzucać ich razem z wywołaniem, które już kosztowało.
      raw = salvageArray(out, "sources");
      run.recovered = raw.length;
      const cut = wasTruncated();
      run.parse = cut ? "truncated" : "bad-json";
      run.err = (cut
        ? `odpowiedź ucięta na limicie ${MAX_TOKENS} tokenów (podnieś DISCOVER_MAX_TOKENS)`
        : `niepoprawny JSON od modelu: ${describeError(e)}`)
        + ` — odzyskano ${raw.length} kompletnych propozycji`;
      console.warn(`  ⚠️ ${town}: ${run.err}`);
      if (!raw.length) return finalize();
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

      const known = reg.urls.get(urlKey(src.url));
      if (known !== undefined) {
        confirm(known, proposal, { run: runStartedAt, town, matched, why });
        if (proposal.decision === "confirmed") run.confirmed++;
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
      // świeże źródło też ma być „widziane w tym przebiegu" — inaczej przelicznik braków
      // zaraz po dodaniu naliczyłby mu pierwsze pudło
      src.lastSeenRun = runStartedAt;
      src.missedRuns = 0;

      reg.cfg.sources.push(src);
      reg.urls.set(urlKey(src.url), src);
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
