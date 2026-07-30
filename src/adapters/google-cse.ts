/**
 * Google Programmable Search (Custom Search JSON API) — dostawca dla kont założonych przed
 * lipcem 2026. NIE jest już domyślny: Google przestało przyjmować nowych klientów, więc
 * świeży projekt nie ma jak dostać `cx`. Domyślnym dostawcą jest `serper.ts`.
 *
 * Wymaga DWÓCH zmiennych: `GOOGLE_API_KEY` oraz `GOOGLE_CSE_CX` (identyfikator wyszukiwarki
 * z programmablesearchengine.google.com). Silnik musi mieć włączone „Search the entire web" —
 * domyślnie przeszukuje tylko wskazane witryny i oddaje zero wyników bez żadnego błędu.
 *
 * Limity: 100 zapytań/dzień gratis, dalej $5/1000, twardy sufit 10 000/dzień.
 */
import { describeError } from "../shared/errors.js";
import { trim } from "../shared/text.js";
import type { SearchCall, SearchProviderOutcome } from "../types/index.js";

import { fetchUrl } from "./http.js";

const GOOGLE_URL = process.env["GOOGLE_URL"] ?? "https://www.googleapis.com/customsearch/v1";
const MAX_DESC_CHARS = 300;

/**
 * Powody błędu, po których dalsze zapytania są pewną stratą czasu (i tak samo pewnym zerem
 * w raporcie). Google zwraca je w CIELE odpowiedzi przy statusie 403 albo 429.
 */
const FATAL_REASONS = new Set([
  "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded",
  "quotaExceeded", "keyInvalid", "accessNotConfigured", "forbidden",
]);

type GoogleError = { error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> } };
type GoogleHit = { title?: string; link?: string; snippet?: string };

/**
 * Jedno zapytanie. Zwraca też werdykt „to był błąd trwały", bo rozstrzygnięcie wymaga
 * zajrzenia do ciała odpowiedzi, a nie tylko do statusu — patrz `readError`.
 */
export async function search(query: string, call: SearchCall): Promise<SearchProviderOutcome> {
  const key = process.env["GOOGLE_API_KEY"];
  const cx = process.env["GOOGLE_CSE_CX"];
  if (!key || !cx) {
    return { results: [], fatal: `brak ${!key ? "GOOGLE_API_KEY" : "GOOGLE_CSE_CX"}` };
  }

  const params = new URLSearchParams({
    key, cx, q: query, num: "10", gl: "pl", hl: "pl", lr: "lang_pl", safe: "off",
  });
  try {
    const res = await fetchUrl(`${GOOGLE_URL}?${params.toString()}`, {}, 20_000, "Google CSE");
    const body = await res.text();
    if (!res.ok) return failure(res.status, body, call);
    const json = JSON.parse(body) as { items?: GoogleHit[] } & GoogleError;
    call.results = (json.items ?? []).map((w) => ({
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

/** Odpowiedź błędna: opis do raportu i decyzja, czy to koniec zabawy dla całego przebiegu. */
function failure(status: number, body: string, call: SearchCall): SearchProviderOutcome {
  call.httpStatus = status;
  const { reason, message } = readError(body);
  call.err = `HTTP ${status}${reason ? ` (${reason})` : ""}: ${trim(message.replace(/\s+/g, " "), 200)}`;
  // 400 to zwykle brak/zły `cx` — powtarzanie go 200 razy niczego nie naprawi
  if (!FATAL_REASONS.has(reason) && status !== 400) return { results: [] };
  return { results: [], fatal: `wyszukiwarka wyłączona po HTTP ${status}${reason ? ` / ${reason}` : ""}` };
}

/**
 * Powód błędu z ciała odpowiedzi. Sam status nie wystarcza i to jest ta sama pułapka, którą
 * opisuje komentarz w `brave.ts`: wyczerpany limit odpowiadał poprawnym JSON-em bez wyników,
 * więc w raporcie wyglądał identycznie jak gmina, w której nic nie znaleziono. U Google
 * `dailyLimitExceeded` przychodzi jako 403 — status nie do odróżnienia od odrzuconego klucza,
 * a `reason` rozstrzyga jedno i drugie.
 */
export function readError(body: string): { reason: string; message: string } {
  try {
    const j = JSON.parse(body) as GoogleError;
    return {
      reason: j.error?.errors?.[0]?.reason ?? "",
      message: j.error?.message ?? trim(body, 200),
    };
  } catch {
    return { reason: "", message: trim(body, 200) };
  }
}
