/**
 * Wyłuskanie odnośników ze strony. Regex, nie parser DOM — świadomie.
 *
 * Potrzebujemy trzech rzeczy (adres, tekst kotwicy, czy siedzi w nawigacji), a dociągnięcie
 * cheerio/jsdom kosztowałoby kilkanaście megabajtów zależności w potoku, który poza tym
 * obywa się `html-to-text`. Nieprawidłowy HTML rozjeżdża tu pojedyncze linki, nigdy całość:
 * heurystyki wyżej i tak liczą, ILE odnośników pasuje do wzorca, więc pojedyncze pudło
 * niczego nie przewraca.
 */

export interface PageLink {
  /** adres bezwzględny, bez fragmentu */
  url: string;
  /** tekst kotwicy, oczyszczony ze znaczników i białych znaków */
  text: string;
  /** kotwica leży w <nav>/<header>/<menu> — kandydat na wejście do działu, nie na wydarzenie */
  inNav: boolean;
}

/** Zakresy znaków zajęte przez nawigację — do rozstrzygania `inNav` po pozycji dopasowania. */
function navRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const tag of ["nav", "header", "menu"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
    for (const m of html.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  // część serwisów nie używa <nav> — łapiemy też kontenery po klasie/id
  for (const m of html.matchAll(/<(?:div|ul)\b[^>]*(?:class|id)=["'][^"']*\b(?:menu|nawigacja|navbar)\b[^"']*["'][\s\S]{0,8000}?<\/(?:div|ul)>/gi)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Odnośniki ze strony, rozwinięte względem `baseUrl` i ograniczone do tego samego hosta.
 * Obce domeny odpadają tu, a nie u wywołującego: każdy konsument tej funkcji szuka struktury
 * JEDNEGO serwisu, a linki do Facebooka i sponsorów tylko rozmywają grupowanie.
 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  let host: string;
  try {
    host = new URL(baseUrl).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return [];
  }
  const navs = navRanges(html);
  const seen = new Set<string>();
  const out: PageLink[] = [];

  for (const m of html.matchAll(/<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = m[1];
    if (!raw || /^(?:#|javascript:|mailto:|tel:|data:)/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/g, "&"), baseUrl);
    } catch {
      continue;
    }
    // porównanie po HOŚCIE, nie po origin: ckzamek.pl wypisuje wydarzenia jako linki http://
    // na stronie serwowanej po https, a `origin` uznawał je za obcą domenę i wycinał —
    // przez co jedyna prawdziwa lista wydarzeń w serwisie znikała przed grupowaniem
    if (url.host.replace(/^www\./i, "").toLowerCase() !== host) continue;
    url.hash = "";
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const at = m.index;
    out.push({
      url: href,
      text: stripTags(m[2] ?? ""),
      inNav: navs.some(([from, to]) => at >= from && at < to),
    });
  }
  return out;
}
