/** Wyjście HTTP: nagłówki udające przeglądarkę i fetch, którego błąd da się przeczytać. */
import { describeError } from "../shared/errors.js";

// Nagłówki jak z przeglądarki — WAF-y części stron gminnych zwracają 403 dla UA botów.
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
};

/**
 * fetch z timeoutem, którego błąd zawsze mówi CO było pobierane i DLACZEGO padło.
 * `label` zastępuje URL w komunikacie, gdy URL zawiera sekrety (np. token bota).
 */
export async function fetchUrl(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  label?: string,
): Promise<Response> {
  const what = label ?? `GET ${url}`;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError"
      ? `timeout po ${timeoutMs / 1000}s`
      : describeError(e);
    throw new Error(`${what}: ${why}`, { cause: e });
  }
}
