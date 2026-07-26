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

/** Adresy FB nie odpowiadają na zwykły fetch (login wall) — weryfikacja URL-a ich nie dotyczy. */
export const isFbFetch = (f: FetchStrategy): boolean =>
  f === "fb" || f === "fb_group" || f === "fb_event";
