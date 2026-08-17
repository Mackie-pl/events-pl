/** Normalizacja adresów — wspólna dla rejestru źródeł i weryfikacji. */
import type { FetchStrategy } from "../types/index.js";

/**
 * Klucz porównania adresów: bez schematu, `www.` i końcowego `/`, z posortowanymi parametrami.
 * Samo obcinanie `/` (poprzednia wersja) uznawało `http://x` i `https://www.x/` za różne źródła,
 * więc ten sam serwis potrafił wejść do rejestru dwa razy.
 */
export function urlKey(u: string): string {
  try {
    const p = new URL(u);
    const host = p.host.replace(/^www\./i, "").toLowerCase();
    const path = p.pathname.replace(/\/+$/, "").toLowerCase();
    const params = [...p.searchParams.entries()]
      .filter(([, v]) => !v.includes("{page}")) // paginacja to nie inne źródło
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return host + path + (params ? `?${params}` : "");
  } catch {
    return u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
  }
}

export const host = (u: string): string => {
  try {
    return new URL(u).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
};

/** Grupa FB: korzeń grupy bez /posts/… i parametrów (prompt o to prosi, ale ufamy-i-sprawdzamy). */
export function normalizeFbGroupUrl(u: string): string {
  const m = u.match(/^https?:\/\/(?:www\.)?facebook\.com\/groups\/([^/?#]+)/i);
  return m ? `https://www.facebook.com/groups/${m[1]}` : u;
}

/**
 * Obraz z rekordu Bright Data: edge CDN-u Facebooka podmieniony na host generyczny.
 *
 * Adres wraca z rekordu z edge'em najbliższym SCRAPEROWI, nie nam. W przebiegu 2026-08-17
 * piętnaście grup oddało piętnaście różnych hostów (Dżudda, Bangkok, Karaczi, Penang, Seattle,
 * Pune, Gimpo…), bo Bright Data pobiera z rotujących wyjść. Jeden z nich, `scontent-gmp1-1`,
 * nie routuje się z naszej sieci: trzy próby, za każdym razem ETIMEDOUT na 31.13.76.14 —
 * przy czternastu pozostałych obraz schodzi bez ciasteczek w 0.3–1.8 s.
 *
 * Podpis w adresie (`oh`/`oe`) NIE jest związany z hostem — ten sam adres z podmienionym
 * edge'em oddaje 200 (sprawdzone 2026-08-17 na `scontent.xx`, `scontent-cdg4-2.xx`
 * i `scontent-waw2-1.xx`). Dlatego to jest normalizacja CUDZEJ odpowiedzi na wejściu,
 * a nie łatka na jedną grupę: przy dwustu źródłach loteria „gdzie akurat stał scraper"
 * cicho zjadałaby część obrazów, a w raporcie wyglądałaby jak post bez załącznika.
 */
export function normalizeFbCdnUrl(u: string): string {
  try {
    const p = new URL(u);
    // tylko hosty obrazowe fbcdn; `video.*` zostawiamy, bo i tak nie idzie do modelu
    if (!/^scontent[^.]*\..*\bfbcdn\.net$/i.test(p.host)) return u;
    p.host = "scontent.xx.fbcdn.net";
    return p.toString();
  } catch {
    return u; // nie parsuje się → nie nasza sprawa, niech padnie na pobraniu z własnym śladem
  }
}

/** Adresy FB nie odpowiadają na zwykły fetch (login wall) — weryfikacja URL-a ich nie dotyczy. */
export const isFbFetch = (f: FetchStrategy): boolean =>
  f === "fb" || f === "fb_group" || f === "fb_event";
