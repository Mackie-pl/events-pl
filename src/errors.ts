/** Formatowanie błędów i fetch z kontekstem — wspólne dla całego pipeline'u. */

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
      parts.push(cur.name && cur.name !== "Error" ? `${cur.name}: ${cur.message}` : cur.message);
      cur = cur.cause;
    } else {
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
