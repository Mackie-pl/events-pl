/**
 * Formatowanie błędów. Osobno od fetchUrl (adapters/http.ts), bo inaczej robi się cykl:
 * http potrzebuje describeError, a describeError nie potrzebuje niczego.
 */

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
