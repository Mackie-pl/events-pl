/**
 * Brave Search — alternatywny dostawca etapu 1 (`SEARCH_PROVIDER=brave`).
 *
 * Przestał być domyślny, bo małe polskie instytucje kultury są w jego indeksie szczątkowo,
 * a to one są celem discovery. Zostaje, bo darmowy tier 2000/mies. jest hojniejszy od
 * Google'owych 100/dzień — dla jednej gminy albo dla ponownego przebiegu weryfikacji bywa
 * tańszym wyborem.
 *
 * Budżet i wyłącznik przebiegu mieszkają w `search.ts` — tu jest wyłącznie jedno zapytanie.
 */
import { P } from "../config/index.js";
import { describeError } from "../shared/errors.js";
import { trim } from "../shared/text.js";
import type { SearchCall, SearchProviderOutcome } from "../types/index.js";

import { fetchUrl } from "./http.js";


const MAX_DESC_CHARS = 300;

/** Darmowy tier Brave dopuszcza 1 zapytanie na sekundę. */
export const RATE_LIMIT_MS = 1_100;

export async function search(query: string, call: SearchCall): Promise<SearchProviderOutcome> {
  const key = P.BRAVE_API_KEY.get();
  if (!key) return { results: [], fatal: "brak BRAVE_API_KEY" };
  try {
    const res = await fetchUrl(
      `${P.BRAVE_URL.get()}?${new URLSearchParams({ q: query, count: "8", country: "pl" }).toString()}`,
      { headers: { "X-Subscription-Token": key } },
      20_000,
      "Brave Search",
    );
    if (!res.ok) {
      call.httpStatus = res.status;
      call.err = `HTTP ${res.status}: ${trim((await res.text()).replace(/\s+/g, " "), 200)}`;
      // klucz odrzucony albo limit — dalsze zapytania to pewne porażki i strata czasu
      const fatal = res.status === 401 || res.status === 403 || res.status === 429;
      return { results: [], ...(fatal ? { fatal: `wyszukiwarka wyłączona po HTTP ${res.status} (klucz/limit)` } : {}) };
    }
    type BraveHit = { title?: string; url?: string; description?: string };
    const json = (await res.json()) as { web?: { results?: BraveHit[] } };
    call.results = (json.web?.results ?? []).map((w) => ({
      title: w.title ?? null,
      url: w.url ?? null,
      desc: w.description ? trim(w.description, MAX_DESC_CHARS) : null,
    }));
    return { results: call.results };
  } catch (e) {
    call.err = describeError(e);
    return { results: [] };
  }
}
