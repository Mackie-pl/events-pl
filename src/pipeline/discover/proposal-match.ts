/** Dopasowanie propozycji modelu do konkretnego wyniku wyszukiwarki — dowód proweniencji. */
import { host, urlKey } from "../../shared/url.js";
import type { SearchResult } from "../../types/index.js";

/** Próg pewności modelu, poniżej którego propozycja nie trafia do rejestru. */
export const MIN_CONFIDENCE = 0.5;

/** Wynik wyszukiwarki, z którego pochodzi ten adres — dowód „skąd model to wziął". */
export function matchHit(
  url: string,
  hits: Array<{ query: string; result: SearchResult }>,
): { query: string; hit: SearchResult } | null {
  const key = urlKey(url);
  const h = host(url);
  const exact = hits.find((x) => x.result.url && urlKey(x.result.url) === key);
  const prefix = hits.find(
    (x) => x.result.url && (urlKey(x.result.url).startsWith(key) || key.startsWith(urlKey(x.result.url))),
  );
  const sameHost = h ? hits.find((x) => x.result.url && host(x.result.url) === h) : undefined;
  const found = exact ?? prefix ?? sameHost;
  return found ? { query: found.query, hit: found.result } : null;
}
