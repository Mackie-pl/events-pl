/**
 * Brave Search — jedyne płatne (poza darmowym tierem) wyjście etapu 1.
 *
 * Liczniki są modułowe, bo budżet obowiązuje CAŁY przebieg, nie pojedyncze wywołanie:
 * discoverTown, verifySource i buildTotals czytają ten sam stan. resetSearchState()
 * istnieje dla testów — w jednym procesie potoku nikt go nie woła.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describeError } from "../shared/errors.js";
import { trim } from "../shared/text.js";
import type { SearchCall, SearchResult } from "../types/index.js";

import { fetchUrl } from "./http.js";

/** Bezpiecznik darmowego tieru Brave (2000/mies.) — pełne discovery 13 gmin to ~130 zapytań. */
const SEARCH_BUDGET = Number(process.env["DISCOVER_MAX_SEARCHES"] ?? 300);
/** Opis wyniku wyszukiwarki bywa akapitem — do raportu wystarczy pierwsze zdanie z hakiem. */
const MAX_DESC_CHARS = 300;
// nadpisywalne jak OPENROUTER_URL: pozwala wpiąć proxy albo mock w testach
const BRAVE_URL = process.env["BRAVE_URL"] ?? "https://api.search.brave.com/res/v1/web/search";

/**
 * Licznik + wyłącznik. Brave przy przekroczeniu limitu odpowiada 429 z poprawnym JSON-em bez
 * `web.results` — poprzednia wersja czytała to jako „zero trafień", więc wyczerpany limit
 * wyglądał w raporcie identycznie jak gmina bez źródeł, a kolejne 100 zapytań i tak leciało.
 */
let searchesUsed = 0;
let searchDisabled: string | null = null;
let searchesSkipped = 0;

export async function webSearch(query: string, log: SearchCall[]): Promise<SearchResult[]> {
  const key = process.env["BRAVE_API_KEY"];
  if (!key) throw new Error("Brak BRAVE_API_KEY");
  const call: SearchCall = { query, results: [], ms: 0 };
  log.push(call);

  if (!searchDisabled && searchesUsed >= SEARCH_BUDGET) {
    searchDisabled = `budżet ${SEARCH_BUDGET} zapytań wyczerpany (DISCOVER_MAX_SEARCHES)`;
  }
  if (searchDisabled) {
    call.skipped = true;
    call.err = searchDisabled;
    searchesSkipped++;
    return [];
  }

  searchesUsed++;
  const t0 = performance.now();
  try {
    const res = await fetchUrl(
      `${BRAVE_URL}?${new URLSearchParams({ q: query, count: "8", country: "pl" }).toString()}`,
      { headers: { "X-Subscription-Token": key } },
      20_000,
      "Brave Search",
    );
    if (!res.ok) {
      call.httpStatus = res.status;
      call.err = `HTTP ${res.status}: ${trim((await res.text()).replace(/\s+/g, " "), 200)}`;
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        // klucz odrzucony albo limit — dalsze zapytania to pewne porażki i strata czasu
        searchDisabled = `wyszukiwarka wyłączona po HTTP ${res.status} (klucz/limit)`;
        console.warn(`Brave: ${call.err} — pomijam pozostałe zapytania w tym przebiegu`);
      }
      return [];
    }
    const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    call.results = (json.web?.results ?? []).map((w) => ({
      title: w.title ?? null,
      url: w.url ?? null,
      desc: w.description ? trim(w.description, MAX_DESC_CHARS) : null,
    }));
    return call.results;
  } catch (e) {
    call.err = describeError(e);
    return [];
  } finally {
    call.ms = Math.round(performance.now() - t0);
    if (!call.skipped) await sleep(1_100); // darmowy tier Brave: 1 zapytanie/s
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
