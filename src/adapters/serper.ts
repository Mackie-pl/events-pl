/**
 * Serper — domyślna wyszukiwarka etapu 1. Wyniki Google bez Google Programmable Search,
 * które przestało przyjmować nowych klientów (07.2026).
 *
 * Wymaga jednej zmiennej: `SERPER_API_KEY`. Darmowe 2500 zapytań na start, potem plany
 * od ~$0.001 za zapytanie — patrz `SEARCH_COST_PER_QUERY` w .env.example.
 *
 * POST z nagłówkiem `X-API-KEY`, nie GET z `?apiKey=` z ich przykładu: klucz w URL-u ląduje
 * w logach, w `SearchCall.query` raportu i w komunikatach błędów `fetchUrl`, a `discover-runs.json`
 * jest commitowany do PUBLICZNEGO repo. To ta sama zasada, dla której `fetchUrl` przyjmuje `label`.
 */
import { describeError } from "../shared/errors.js";
import { trim } from "../shared/text.js";
import type { SearchCall, SearchProviderOutcome } from "../types/index.js";

import { fetchUrl } from "./http.js";

const SERPER_URL = process.env["SERPER_URL"] ?? "https://google.serper.dev/search";
const MAX_DESC_CHARS = 300;

/**
 * Kody, po których dalsze zapytania są pewną stratą: klucz odrzucony (401/403), kredyty
 * wyczerpane (402) albo limit tempa (429). Serper nie ma osobnego pola z powodem — niesie
 * go zwykły `message`, więc do raportu bierzemy jedno i drugie.
 */
const FATAL_STATUS = new Set([400, 401, 402, 403, 429]);

type SerperHit = { title?: string; link?: string; snippet?: string };

/** Komunikat błędu Serpera: `{"message":"Unauthorized."}`; przy awarii bramy bywa HTML. */
export function readError(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown };
    const m = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : "";
    return m || trim(body.replace(/\s+/g, " "), 200);
  } catch {
    return trim(body.replace(/\s+/g, " "), 200);
  }
}

export async function search(query: string, call: SearchCall): Promise<SearchProviderOutcome> {
  const key = process.env["SERPER_API_KEY"];
  if (!key) return { results: [], fatal: "brak SERPER_API_KEY" };

  try {
    const res = await fetchUrl(
      SERPER_URL,
      {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        // gl/hl: wyniki krajowe i polskojęzyczne — bez tego mała instytucja gminna ginie
        body: JSON.stringify({ q: query, gl: "pl", hl: "pl", num: 10 }),
      },
      20_000,
      "Serper", // label zamiast URL-a: komunikat błędu nie może nieść klucza
    );
    const body = await res.text();
    if (!res.ok) {
      call.httpStatus = res.status;
      const message = readError(body);
      call.err = `HTTP ${res.status}: ${message}`;
      if (!FATAL_STATUS.has(res.status)) return { results: [] };
      return { results: [], fatal: `wyszukiwarka wyłączona po HTTP ${res.status}: ${message}` };
    }
    const json = JSON.parse(body) as { organic?: SerperHit[]; credits?: number };
    call.results = (json.organic ?? []).map((w) => ({
      title: w.title ?? null,
      url: w.link ?? null,
      desc: w.snippet ? trim(w.snippet, MAX_DESC_CHARS) : null,
    }));
    return { results: call.results };
  } catch (e) {
    call.err = describeError(e);
    return { results: [] };
  }
}
