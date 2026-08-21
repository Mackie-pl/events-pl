/**
 * PAGER BEZ ADRESÓW: zgadywanie nazwy parametru z DARMOWĄ wyrocznią.
 *
 * `paginate.ts` czyta adres strony 2 wprost z pagera i to jest droga podstawowa. Zostaje
 * przypadek, w którym czytać nie ma czego: okpoznan.pl wypisuje
 * `<a class="js_ajax_box_page_link">2</a>` bez `href`, bo numer dokłada JS w wywołaniu AJAX.
 *
 * Zgadywanie nazwy parametru odrzuciliśmy przy `nextPageUrl` — i słusznie, bo tam było
 * NIESPRAWDZALNE. Tutaj jest sprawdzalne za darmo. Pomiar 2026-08-21 na okpoznan.pl:
 *
 *   ?active_page=2                  16 adresów, 16 nowych  → działa
 *   ?page=2 ?pno=2 ?p=2 ?strona=2   16 adresów, ZERO nowych → to nadal strona 1, z kodem 200
 *
 * Zła nazwa nie daje błędu — oddaje stronę pierwszą i wygląda jak sukces. Bez wyroczni
 * płacilibyśmy co dzień za duplikat i widzieli w raporcie „strona 2 przeczytana". Dlatego
 * kandydaci są TYLKO generatorem, a rozstrzyga porównanie kompletu wpisów: pobranie HTTP nic
 * nie kosztuje, więc weryfikacja jest darmowa i pewna, a nie heurystyczna.
 *
 * CZEMU NIE PRZEGLĄDARKA: okpoznan paginuje po stronie serwera, JS tylko składa adres.
 * Playwright (dziś `optionalDependency`, niezainstalowany) umiałby kliknąć, ale `fetchHeadless`
 * potrafi wyłącznie `goto` + `content()`, więc kliknięcie w pager to nowy kod, ~150 MB
 * przeglądarki w CI i czas na stronę — po to, żeby dostać adres, który i tak da się zgadnąć
 * i sprawdzić za darmo. Przeglądarka zostaje na wypadek listy renderowanej naprawdę po stronie
 * klienta; takiego źródła w rejestrze na 2026-08-21 nie ma ani jednego.
 */
import { type AnyNode, type Element, hasChildren, isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";

import { daysBetween } from "../../shared/dates.js";
import { extractLinks } from "../../shared/links.js";
import { detailGroup, urlTemplate } from "../../shared/url-template.js";
import type { PipelineState } from "../../types/index.js";

/**
 * Nazwy parametru strony do sprawdzenia, w kolejności od najczęstszych.
 *
 * To NIE jest lista wyjątków per serwis, mimo że tak wygląda — bo żadna pozycja nie jest tu
 * przyjmowana na wiarę. Wyrocznia niżej odrzuca każdą, która oddaje stronę pierwszą, więc
 * najgorsze, co robi zła nazwa, to jedno darmowe pobranie. Lista ma być KRÓTKA z tego samego
 * powodu: każda pozycja to jedno pobranie u cudzego serwisu przy każdej sondzie.
 */
const KANDYDACI = ["active_page", "page", "p", "pno", "strona", "paged"];

/** Wszystkie elementy o danym znaczniku, w kolejności dokumentu. */
function descendants(root: AnyNode, tag: string, out: Element[] = []): Element[] {
  if (isTag(root) && root.tagName === tag) out.push(root);
  if (hasChildren(root)) for (const c of root.children) descendants(c, tag, out);
  return out;
}

/** Odnośnik podpisany samą liczbą — kandydat na numer strony. */
const numeryczny = (a: Element): boolean => /^\d{1,3}$/u.test(textContent(a).trim());

/** Adres, po którym da się przejść dalej; `#` i `javascript:` nim nie są. */
const maAdres = (a: Element): boolean => {
  const h = (a.attribs["href"] ?? "").trim();
  return h !== "" && !h.startsWith("#") && !h.toLowerCase().startsWith("javascript:");
};

/**
 * Czy strona MA pager, ale jego numery nigdzie nie prowadzą.
 *
 * Warunek jest celowo ostry z obu stron. Brak numerów = strona bez paginacji, nie ma czego
 * sondować. Numery Z adresami = zwykła droga (`nextPageUrl`), a sonda dokładałaby do niej
 * pobrania po nic. Sondujemy wyłącznie tam, gdzie widać, że dalszy ciąg ISTNIEJE, a adresu
 * do niego nie ma.
 */
export function pagerWithoutLinks(html: string): boolean {
  const numery = descendants(parseDocument(html), "a").filter(numeryczny);
  if (numery.length < 2) return false;
  return !numery.some(maAdres);
}

/**
 * Adresy do sprawdzenia dla strony `page`. Parametry, które strona już niosła, ZOSTAJĄ —
 * listing bywa zawężony filtrem (`?by=month`) i kandydat bez niego pytałby o inną listę,
 * a wtedy wyrocznia porównywałaby dwie różne rzeczy.
 */
export function pageCandidates(pageUrl: string, page: number): string[] {
  return pageCandidateTemplates(pageUrl).map((t) => t.replace(SLOT, String(page)));
}

/** Ten sam placeholder, którego używa `Source.url` i `runPages` — jeden kształt w całym potoku. */
const SLOT = "{page}";
/** Wartość alfanumeryczna, więc `searchParams` jej nie zakoduje; podmieniamy ją na `{page}`. */
const ZNACZNIK = "EVPLPAGE";

/**
 * Kandydaci jako SZABLONY z `{page}` — bo werdykt sondy zapamiętujemy dla źródła, a nie dla
 * jednej strony: raz sprawdzona nazwa parametru obsługuje potem stronę 3, 4 i jutrzejszą 2.
 *
 * Placeholder wstawiamy przez znacznik alfanumeryczny, a nie wprost: `searchParams.set`
 * zakodowałoby klamry na `%7Bpage%7D` i szablon przestałby pasować do podmiany.
 */
export function pageCandidateTemplates(pageUrl: string): string[] {
  const out: string[] = [];
  for (const nazwa of KANDYDACI) {
    try {
      const u = new URL(pageUrl);
      u.searchParams.set(nazwa, ZNACZNIK);
      const s = u.toString().replace(ZNACZNIK, SLOT);
      if (!out.includes(s)) out.push(s);
    } catch { /* adres nie do rozłożenia — nie ma czego sondować */ }
  }
  return out;
}

/**
 * KSZTAŁT LISTY tej strony — szablon adresu wpisu (`okpoznan.pl/szczegoly-wydarzenia/{slug}`)
 * albo `null`, gdy strona żadnej listy nie ma.
 *
 * Eksportowane, bo służy dwóm rzeczom naraz: wyroczni sondy i bramce OGONA paginacji.
 * `null` znaczy „nie umiem tego ocenić", nie „to nie jest lista" — i wywołujący ma wtedy
 * przepuścić stronę, a nie ją odrzucić. Fail closed byłby tu odwrotnością tego, co trzeba:
 * skasowałby paginację serwisom, których listy nie rozpoznajemy szablonem.
 */
export function listingShape(html: string, pageUrl: string): string | null {
  try {
    return detailGroup(extractLinks(html, pageUrl), new URL(pageUrl).pathname)?.template ?? null;
  } catch {
    return null;
  }
}

/** Wpisy listingu: odnośniki o kształcie strony pojedynczego wydarzenia. */
function wpisy(html: string, pageUrl: string, szablon: string | null): Set<string> {
  const links = extractLinks(html, pageUrl);
  const wzor = szablon ?? detailGroup(links, new URL(pageUrl).pathname)?.template ?? null;
  if (!wzor) return new Set();
  return new Set(links.filter((l) => urlTemplate(l.url) === wzor).map((l) => l.url));
}

/** Werdykt wyroczni — ze zdaniem do śladu, bo „ok: false" samo z siebie nic nie tłumaczy. */
export interface NextPageVerdict {
  ok: boolean;
  why: string;
}

/**
 * Czy `candidateHtml` to KOLEJNA strona tego listingu, czy ta sama pierwsza.
 *
 * Porównujemy komplety wpisów o tym samym kształcie adresu, co na stronie 1 — nie same hashe
 * treści. Hash różni się także wtedy, gdy serwis wstawił inny baner albo licznik odsłon,
 * a wtedy „inna treść" znaczyłoby „inna strona" i wpuszczalibyśmy duplikat.
 *
 * PRZEWAGA nowych, a nie rozłączność: listingi bywają posortowane tak, że wpis z pogranicza
 * wraca na obu stronach, i jeden wspólny adres nie może unieważnić całej strony. Wymagamy
 * za to co najmniej dwóch nowych — jeden bywa efektem wpisu dodanego między pobraniami.
 */
export function isNextPage(baseHtml: string, candidateHtml: string, pageUrl: string): NextPageVerdict {
  const szablon = listingShape(baseHtml, pageUrl);
  if (!szablon) return { ok: false, why: "strona 1 nie ma rozpoznawalnej listy wpisów" };

  const a = wpisy(baseHtml, pageUrl, szablon);
  const b = wpisy(candidateHtml, pageUrl, szablon);
  if (!b.size) return { ok: false, why: "kandydat nie ma ani jednego wpisu w kształcie listy" };

  const nowe = [...b].filter((u) => !a.has(u)).length;
  if (nowe < 2) {
    return { ok: false, why: `te same wpisy co na stronie 1 (${nowe} nowych z ${b.size})` };
  }
  return { ok: true, why: `${nowe} z ${b.size} wpisów nieobecnych na stronie 1` };
}

/**
 * Werdykt sondy zapamiętany dla źródła — albo `undefined`, gdy trzeba sondować od nowa.
 *
 * `url: null` w wyniku to PEŁNOPRAWNA odpowiedź („sprawdzone, nic nie działa"), nie brak
 * odpowiedzi. Rozróżnienie jest tu całą wartością pamięci: bez niego sześć pobrań u cudzego
 * serwisu wracałoby w każdym przebiegu, bo najczęstszym wynikiem sondy jest właśnie odmowa.
 *
 * Wygasanie liczone przy ODCZYCIE, a nie zapisane jako data końcowa — tak samo jak
 * `sameAsPage` w followup-queue.ts: zmiana progu ma działać od razu.
 */
export function rememberedPager(
  state: PipelineState, srcId: string, today: string, recheckDays: number,
): { url: string | null } | undefined {
  const wpis = state.pagerTemplate?.[srcId];
  if (!wpis) return undefined;
  if (daysBetween(wpis.at, today) >= recheckDays) return undefined;
  return { url: wpis.url };
}

/** Zapis werdyktu — TAKŻE odmownego (`null`), patrz `rememberedPager`. */
export function notePager(
  state: PipelineState, srcId: string, url: string | null, today: string,
): void {
  (state.pagerTemplate ??= {})[srcId] = { url, at: today };
}
