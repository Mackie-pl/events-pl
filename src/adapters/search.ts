/**
 * Wyszukiwarka etapu 1 — wybór dostawcy i budżet CAŁEGO przebiegu.
 *
 * Dostawcy (`google-cse.ts`, `brave.ts`) umieją jedno zapytanie i nic o sobie nie wiedzą.
 * Tu mieszka to, co dotyczy przebiegu jako całości: licznik, sufit zapytań i wyłącznik po
 * błędzie trwałym. Liczniki są modułowe, bo czytają je trzy różne miejsca (discoverTown,
 * verifySource, buildTotals), a budżet obowiązuje je wspólnie.
 *
 * `resetSearchState()` istnieje dla testów — w jednym procesie potoku nikt go nie woła.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { P } from "../config/index.js";
import type { SearchCall, SearchResult } from "../types/index.js";

import { RATE_LIMIT_MS as BRAVE_RATE, search as braveSearch } from "./brave.js";
import { search as googleSearch } from "./google-cse.js";
import { search as serperSearch } from "./serper.js";

/**
 * Bezpiecznik: pełne discovery to ~10 zapytań na gminę. Dla Poznania +15 km (13 gmin) to ~130,
 * ale dla Warszawy z dzielnicami rząd wielkości to już 200+. Sufit ma zaboleć, zanim zaboli
 * rachunek — u Serpera darmowa pula 2500 zapytań kończy się po kilkunastu pełnych przebiegach.
 */
const SEARCH_BUDGET = (): number => P.DISCOVER_MAX_SEARCHES.get();

/**
 * Dostawca. Domyślnie Serper: Google Programmable Search przestało przyjmować nowych klientów
 * (07.2026), a Brave szczątkowo indeksuje małe polskie instytucje, czyli cel discovery.
 * `google-cse` zostaje dla kont założonych wcześniej.
 */
const PROVIDERS = {
  serper: { name: "Serper", run: serperSearch, keys: ["SERPER_API_KEY"], throttleMs: 0 },
  google: { name: "Google CSE", run: googleSearch, keys: ["GOOGLE_API_KEY", "GOOGLE_CSE_CX"], throttleMs: 0 },
  // darmowy tier Brave dopuszcza 1 zapytanie na sekundę
  brave: { name: "Brave", run: braveSearch, keys: ["BRAVE_API_KEY"], throttleMs: BRAVE_RATE },
} as const;

const active = (): (typeof PROVIDERS)[keyof typeof PROVIDERS] => PROVIDERS[P.SEARCH_PROVIDER.get()];

let searchesUsed = 0;
let searchDisabled: string | null = null;
let searchesSkipped = 0;

/** Nazwa dostawcy do komunikatów i raportu. */
export const searchProvider = (): string => active().name;

/** Czy w ogóle mamy czym szukać — verifySource pyta o to przed próbą naprawy. */
export const searchConfigured = (): boolean => active().keys.every((k) => Boolean(P[k].get()));

export async function webSearch(query: string, log: SearchCall[]): Promise<SearchResult[]> {
  const call: SearchCall = { query, results: [], ms: 0 };
  log.push(call);

  if (!searchDisabled && searchesUsed >= SEARCH_BUDGET()) {
    searchDisabled = `budżet ${SEARCH_BUDGET()} zapytań wyczerpany (DISCOVER_MAX_SEARCHES)`;
  }
  if (searchDisabled) {
    call.skipped = true;
    call.err = searchDisabled;
    searchesSkipped++;
    return [];
  }

  searchesUsed++;
  const provider = active();
  const t0 = performance.now();
  try {
    const out = await provider.run(query, call);
    if (out.fatal) {
      searchDisabled = out.fatal;
      console.warn(`${provider.name}: ${call.err ?? out.fatal} — pomijam pozostałe zapytania w tym przebiegu`);
    }
    return out.results;
  } finally {
    call.ms = Math.round(performance.now() - t0);
    if (!call.skipped && provider.throttleMs) await sleep(provider.throttleMs);
  }
}

/** Stan budżetu wyszukiwarki — czytany przy budowaniu totals i kosztów. */
export const searchState = (): { used: number; skipped: number; disabled: string | null } =>
  ({ used: searchesUsed, skipped: searchesSkipped, disabled: searchDisabled });

export function resetSearchState(): void {
  searchesUsed = 0;
  searchesSkipped = 0;
  searchDisabled = null;
}
