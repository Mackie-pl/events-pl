/** Formatowanie błędów i fetch z kontekstem — wspólne dla całego pipeline'u. */

// Nagłówki jak z przeglądarki — WAF-y części stron gminnych zwracają 403 dla UA botów.
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
};

/**
 * `String(e)` gubi to, co najważniejsze: undici pakuje prawdziwą przyczynę
 * ("TypeError: fetch failed" -> ENOTFOUND / ECONNRESET / błąd certyfikatu)
 * w `e.cause`, a "TimeoutError" nie mówi, czego dotyczył.
 * Tu rozwijamy cały łańcuch przyczyn w jedną czytelną linię.
 */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    if (cur instanceof AggregateError) {
      // np. równoległe próby połączeń IPv4/IPv6
      parts.push(cur.errors.slice(0, 3).map((s) => (s instanceof Error ? s.message : String(s))).join(" | "));
      break;
    }
    if (cur instanceof Error) {
      const label = cur.name && cur.name !== "Error" ? `${cur.name}: ${cur.message}` : cur.message;
      // nie powielaj: wrapper z fetchUrl ma opis przyczyny już w treści
      if (!parts.some((p) => p.includes(label))) parts.push(label);
      cur = cur.cause;
    } else {
      // Ostatnia deska ratunku w opisie błędu: cur ma typ unknown, a String() nigdy nie rzuca.
      // JSON.stringify byłby czytelniejszy dla obiektów, ale wywala się na cyklach — a wysypka
      // w formatowaniu błędu zjadłaby błąd źródłowy.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- String() nie może rzucić
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ← ") || String(e);
}

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
