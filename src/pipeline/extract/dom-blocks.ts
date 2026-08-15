/**
 * Podział strony na bloki PO DOM-ie: powtarzalne rodzeństwo = karty wydarzeń.
 *
 * Podział po akapitach (blocks.ts) mierzy się sam i wyszło mu, że gubi: przy suficie 86.9%
 * odzyskiwał 75.7%, a na `tarnowo-gok` 25.4% przy suficie 96.2%. Powód jest strukturalny —
 * akapit nie wie, gdzie kończy się karta wydarzenia, więc granica potrafi wypaść w jej środku
 * i jedna zmieniona data unieważnia blok obejmujący pół sąsiedniej karty. HTML wie: karty to
 * rodzeństwo o tym samym kształcie.
 *
 * TRZY DECYZJE, które trzymają tu wszystko razem:
 *
 * 1. Renderujemy `toText()` z page-fetch.ts, nie własną funkcją. Blok ma być DOKŁADNIE tym
 *    tekstem, którym byłby jako część całej strony — inaczej hasze się nie zgadzają i cache
 *    chybia zawsze.
 *
 * 2. Karty zastępujemy znacznikiem i renderujemy dokument JEDEN raz. Alternatywa — renderować
 *    osobno każdy kawałek reszty — rozjeżdża białe znaki na szwach. Tak reszta strony powstaje
 *    tym samym przebiegiem, co dziś, a znaczniki wyznaczają, gdzie ją pociąć.
 *
 * 3. Brak powtarzalnego rodzeństwa = schodzimy na podział po akapitach. Strona pojedynczego
 *    wydarzenia nie ma kart i nie ma czego szukać; udawanie, że ma, byłoby gorsze od dzisiejszego
 *    zachowania.
 *
 * Nadwykrycie jest tanie, niedowykrycie drogie: trzy widżety w pasku bocznym uznane za „karty"
 * to nadal poprawne, lokalne bloki cache'a. Przeoczona lista wydarzeń to pełna cena za stronę
 * bez zmian. Stąd progi poniżej są liberalne.
 */
import render from "dom-serializer";
import { type AnyNode, type Element, Text, hasChildren, isTag } from "domhandler";
import { removeElement, textContent } from "domutils";
import { parseDocument } from "htmlparser2";

import { toText } from "../../adapters/page-fetch.js";

import { type Block, segment, toBlock } from "./blocks.js";

/** Tyle samokształtnego rodzeństwa uznajemy za listę. Dwa to za mało — bywa układem 2-kolumnowym. */
const MIN_SIBLINGS = 3;
/** Krótsze „karty" to elementy menu i ikony, nie wydarzenia. */
const MIN_CARD_CHARS = 40;
/** Dłuższe znaczy, że trafiliśmy na sekcje, a nie karty — schodzimy głębiej zamiast ciąć tutaj. */
const MAX_CARD_CHARS = 6000;

/**
 * Chrom wycinamy Z DRZEWA, zanim cokolwiek podzielimy — mimo że `toText()` i tak go pomija
 * przy renderowaniu. Bez tego menu wpadałoby do treści karty, gdyby stało w jej środku,
 * i zmiana podświetlenia „aktywnej" pozycji unieważniałaby kartę bez zmiany wydarzenia.
 * Lista jest ta sama, co TEXT_SELECTORS w page-fetch.ts, i ma taka zostać.
 */
const CHROME_TAGS = new Set(["nav", "script", "style", "noscript", "footer", "header", "aside"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search"]);

const isChrome = (el: Element): boolean =>
  CHROME_TAGS.has(el.tagName) || CHROME_ROLES.has(el.attribs["role"] ?? "");

/**
 * `hasChildren`, nie `isTag` — korzeń dokumentu NIE jest znacznikiem, więc warunek na `isTag`
 * kończył obchód na pierwszym węźle i całe przycinanie było ciche i bezczynne. Objawu nie
 * dawało się zobaczyć w tekście (`toText` i tak pomija chrom przy renderowaniu), za to
 * `textContent` w `sized()` liczył menu do rozmiaru karty i psuł decyzję o grupie.
 */
function prune(node: AnyNode): void {
  if (!hasChildren(node)) return;
  node.children = node.children.filter((c) => !(isTag(c) && isChrome(c)));
  for (const c of node.children) prune(c);
}

/**
 * Klasy, które WYRZUCAMY z podpisu, bo CMS-y wpisują w nie pozycję rekordu, a nie jego rodzaj.
 * Bez tego `post-142 odd first` i `post-143 even` to dwa różne kształty i lista rozpada się
 * na same jednoelementowe grupy — czyli wykrywanie nie działa akurat tam, gdzie jest potrzebne.
 */
const CLASS_STOPLIST = new Set(["first", "last", "odd", "even", "alt", "active", "current"]);
const hasDigit = /\d/;

function signature(el: Element): string {
  const cls = (el.attribs["class"] ?? "")
    .split(/\s+/)
    .filter((c) => c && !hasDigit.test(c) && !CLASS_STOPLIST.has(c.toLowerCase()))
    .sort();
  return `${el.tagName}.${cls.join(".")}`;
}

/**
 * Czego NIE wolno uznać za kartę, bo html-to-text nie renderuje tego jako osobnego bloku.
 *
 * WNĘTRZE TABELI w całości, i to nie z ostrożności. Bez opcji `tables` html-to-text skleja
 * całą tabelę w jedną linię, więc znacznik wstawiony gdziekolwiek w środku rozbija tę linię
 * i tekst bloku przestaje być fragmentem strony. Kosztowało to dwa pomiary z rzędu:
 * najpierw komórki kalendarza goksezam.pl (`<td>`, siedem w wierszu — wzorowo powtarzalne
 * rodzeństwo), potem WIERSZE tabelki cookies na estrada.poznan.pl (`<tr>`), przez które
 * samokontrola odrzucała podział CAŁEJ strony razem z jej 38 kartami wydarzeń.
 *
 * Elementy liniowe nie są rekordem w ogóle — karta to blok treści, nie kawałek zdania.
 */
const NOT_A_CARD = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "span", "a", "em", "strong", "b", "i", "u", "small", "label",
  "br", "img", "input", "button", "option", "code", "abbr", "time",
]);

/**
 * Czemu ten element nie jest kartą — pełnym zdaniem, nie `false`.
 *
 * Predykat wystarczał do CIĘCIA, ale nie do wytłumaczenia, czemu strona z widoczną listą
 * wydarzeń poszła podziałem po akapitach. Odpowiedź zawsze była jedna z trzech (nie ten
 * znacznik, za krótkie, za długie) i zawsze siedziała tutaj — tyle że nigdzie nie wychodziła.
 */
function whyNotCard(el: Element): string | null {
  if (NOT_A_CARD.has(el.tagName)) return `<${el.tagName}> nie renderuje się jako osobny blok`;
  const n = textContent(el).trim().length;
  if (n < MIN_CARD_CHARS) return `${n} zn. — poniżej progu karty (${MIN_CARD_CHARS})`;
  if (n > MAX_CARD_CHARS) return `${n} zn. — powyżej progu karty (${MAX_CARD_CHARS})`;
  return null;
}

const sized = (el: Element): boolean => whyNotCard(el) === null;

/** Grupa rodzeństwa, która była listą co do liczebności, a odpadła na rozmiarze karty. */
export interface NearMiss {
  /** podpis kształtu (`article.event`) — po nim widać, na co patrzeć w HTML-u */
  sig: string;
  /** ilu członków miała grupa */
  n: number;
  /** powód odrzucenia pierwszego członka, który nie przeszedł */
  why: string;
}

/**
 * Największa grupa samokształtnego rodzeństwa w tym elemencie — albo null.
 *
 * Dwa podejścia po kolei, bo jedno nie wystarcza: podpis z klasami odróżnia karty od
 * przypadkowych sąsiadów, ale serwisy bez klas (gołe `<li>`, `<article>`) dają wtedy jedną
 * wielką grupę „bez klas" i to też jest poprawna odpowiedź. Gdy pierwszy nic nie da,
 * pytamy o sam znacznik.
 *
 * `misses` zbiera odrzucenia po drodze. Zbieramy je ZAWSZE, a nie tylko przy braku kart:
 * strona z rozpoznaną listą i drugą, nierozpoznaną, wygląda w rachunku jak strona z jedną
 * listą — a to jest właśnie ten przypadek, w którym cache traci najwięcej po cichu.
 */
function cardGroup(el: Element, misses: NearMiss[]): Element[] | null {
  const kids = el.children.filter(isTag);
  if (kids.length < MIN_SIBLINGS) return null;
  for (const sig of [signature, (e: Element): string => e.tagName]) {
    const groups = new Map<string, Element[]>();
    for (const k of kids) {
      const s = sig(k);
      groups.set(s, [...(groups.get(s) ?? []), k]);
    }
    const best = [...groups.entries()]
      .filter(([, g]) => g.length >= MIN_SIBLINGS)
      .sort(([, a], [, b]) => b.length - a.length)[0];
    if (!best) continue;
    // wszystkie muszą się mieścić w rozmiarze karty; jeden przerost znaczy, że to sekcje
    // i właściwa lista siedzi niżej — wtedy `null` posyła obchód głębiej
    const [sigOf, group] = best;
    if (group.every(sized)) return group;
    const why = group.map(whyNotCard).find((w) => w !== null);
    if (why) noteMiss(misses, { sig: sigOf, n: group.length, why });
  }
  return null;
}

/** Ile odrzuceń wpuszczamy do śladu. Diagnoza, nie log — dłuższa lista niczego nie dodaje. */
const MAX_MISSES = 5;

/** Ten sam kształt bywa na stronie kilka razy; zostaje najliczniejsze wystąpienie. */
function noteMiss(misses: NearMiss[], miss: NearMiss): void {
  const prev = misses.find((m) => m.sig === miss.sig);
  if (prev) {
    if (miss.n > prev.n) Object.assign(prev, miss);
    return;
  }
  if (misses.length < MAX_MISSES) misses.push(miss);
}

/** Karty w kolejności dokumentu. Do wnętrza karty nie schodzimy — jest już jednostką. */
function collectCards(node: AnyNode, out: Element[], misses: NearMiss[]): void {
  if (!isTag(node)) return;
  const group = cardGroup(node, misses);
  if (!group) {
    for (const c of node.children) collectCards(c, out, misses);
    return;
  }
  const inGroup = new Set<AnyNode>(group);
  for (const c of node.children) {
    if (inGroup.has(c)) out.push(c as Element);
    else collectCards(c, out, misses); // rodzeństwo spoza grupy może samo zawierać listę
  }
}

/**
 * ODCHUDZANIE KARTY: to samo powiedziane drugi raz nie niesie treści, a płacimy za nie jak
 * za treść.
 *
 * Pomiar na poznan.pl (2026-08-14, 34 karty): 4 021 z 23 894 znaków kart (16.9%) to wiersz,
 * który w tej samej karcie już stał. CMS wypuszcza `<img>` osobno dla desktopu i dla mobile
 * (ten sam `alt`), kategorię osobno dla stanu przed i po kliknięciu (ten sam odnośnik),
 * a adres wydarzenia niesie w trzech odnośnikach: obrazek, tytuł i „Zobacz szczegóły".
 *
 * DWIE OSTROŻNOŚCI, bez których to by szkodziło:
 *
 * 1. Odchudzanie chodzi po KARCIE, nigdy po całej stronie. Kategoria „Muzyka" wraca w co
 *    trzeciej karcie i odsiew liczony globalnie uzależniłby treść karty od jej sąsiadek —
 *    czyli skasowałby lokalność, dla której cały podział na bloki powstał. Strzeże tego
 *    `test/prompt-noise.test.ts` na prawdziwej stronie.
 *
 * 2. Powtórzony obrazek dostaje PUSTY `alt`, a nie kasowanie węzła, i powtórzony odnośnik
 *    traci `href`, a nie tekst. Adresy obrazków są jedynym wejściem ścieżki plakatowej
 *    (followup-plakat), więc wycięcie węzła kupowałoby znaki jej kosztem.
 */
/** Wszystkie elementy o danym znaczniku w obrębie karty, w kolejności dokumentu. */
function descendants(root: Element, tag: string): Element[] {
  const out: Element[] = [];
  const walk = (n: AnyNode): void => {
    if (isTag(n) && n.tagName === tag) out.push(n);
    if (hasChildren(n)) for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** Ten sam `alt` drugi raz to responsywny wariant tego samego obrazka — opis zostaje przy pierwszym. */
function thinImages(card: Element): number {
  const alts = new Set<string>();
  let zdjete = 0;
  for (const img of descendants(card, "img")) {
    const alt = (img.attribs["alt"] ?? "").trim();
    if (!alt) continue;
    if (alts.has(alt)) {
      img.attribs["alt"] = "";
      zdjete += alt.length;
    } else alts.add(alt);
  }
  return zdjete;
}

/** Ten sam adres w kilku odnośnikach karty — zostaje przy tym, który niesie własny tekst. */
function thinLinks(card: Element): number {
  const byHref = new Map<string, Element[]>();
  for (const a of descendants(card, "a")) {
    const href = a.attribs["href"];
    if (href) byHref.set(href, [...(byHref.get(href) ?? []), a]);
  }
  let zdjete = 0;
  for (const [href, group] of byHref) {
    if (group.length < 2) continue;
    // adres zostaje przy odnośniku z WŁASNYM tekstem (tytuł karty), a nie przy tym owiniętym
    // wokół obrazka — model ma go zobaczyć przy nazwie wydarzenia, nie przy opisie plakatu
    const keep = group.find((a) => textContent(a).trim() !== "") ?? group[0];
    if (!keep) continue;
    const kept = textContent(keep).trim();
    for (const a of group) {
      if (a === keep) continue;
      const own = textContent(a).trim();
      if (own !== "" && own === kept) {
        // ten sam adres POD TYM SAMYM tekstem — kategoria wypuszczona drugi raz dla stanu
        // po kliknięciu. Nie niesie ani słowa więcej, więc znika w całości, a nie sam `href`
        removeElement(a);
        zdjete += own.length + href.length + 3;
        continue;
      }
      delete a.attribs["href"];
      zdjete += href.length + 3; // „ [href]" — tyle znika z renderu
    }
  }
  return zdjete;
}

/** Zwraca ZDJĘTE znaki — potok ma o tym meldować, bo to zmiana treści idącej do modelu. */
const thinCard = (card: Element): number => thinImages(card) + thinLinks(card);

/**
 * Znacznik wstawiany PRZED i PO każdej karcie, żeby cały dokument dało się wyrenderować
 * JEDEN raz i pociąć wynik.
 *
 * Pierwsza wersja renderowała poddrzewo karty osobno (`toText(render(el))`) i to był błąd
 * wart 56 punktów procentowych: pomiar na żywych stronach pokazał `komorniki-city` 100% → 43%
 * i `palmiarnia` 100% → 68% na stronach, które w ogóle się nie zmieniły. Powód jest w
 * html-to-text: tekst elementu ZALEŻY OD KONTEKSTU — `<li>` wyrwane z `<ul>` traci wypunktowanie,
 * komórka traci szew tabeli, a sąsiedztwo inline'ów zmienia białe znaki. Blok wyglądał więc
 * inaczej niż ten sam fragment w całej stronie, czyli miał inny hash i cache chybiał ZAWSZE.
 *
 * Karty nigdy się nie zagnieżdżają (do wnętrza karty nie schodzimy), więc znaczniki zawsze
 * chodzą parami i podział daje na przemian: reszta, karta, reszta, karta…
 */
const MARK = "@@EVPL_BLOCK@@";
const MARK_SPLIT = /@@EVPL_BLOCK@@/;

export interface DomSegmentation {
  blocks: Block[];
  /** ile bloków pochodzi z wykrytych kart — 0 znaczy, że zeszliśmy na podział po akapitach */
  cards: number;
  /**
   * Hashe bloków będących KARTAMI, a nie resztą strony. Karta ma własny adres wydarzenia
   * i nadaje się do kluczowania tożsamością; nagłówek sekcji czy stopka treściowa nie.
   * Bez tego rozróżnienia nie da się nawet ZMIERZYĆ, ile kart ma własny odnośnik.
   */
  cardHashes: string[];
  /** czy w ogóle znaleziono powtarzalne rodzeństwo */
  detected: boolean;
  /**
   * Znaki zdjęte z kart przez `thinCard` — powtórzone opisy obrazków i adresy. Wchodzi do
   * śladu, bo to JEDYNE miejsce, w którym potok wysyła modelowi coś innego, niż stoi na
   * stronie; bez liczby w audycie różnica byłaby niewidoczna aż do rachunku.
   */
  thinned: number;
  /**
   * Znaczniki zmieniły render, więc wynik ODRZUCONO i zszliśmy na podział po akapitach.
   * Sygnał do obejrzenia strony, nie awaria — patrz `assertSameLines`.
   */
  perturbed?: boolean;
  /**
   * Pierwsze miejsce rozjazdu, gdy `perturbed`. Bez tego „DOM odrzucony" jest ślepe:
   * wiadomo, że podział czegoś nie umie, ale nie CZEGO — a to zawsze był jakiś jeden
   * kształt HTML-a (komórki tabeli), nie ogólna wada metody.
   */
  perturbedAt?: string;
  /**
   * Grupy rodzeństwa, które miały liczebność listy, a odpadły na progu rozmiaru karty.
   * To jedyna odpowiedź na „widzę na tej stronie listę wydarzeń, czemu potok jej nie widzi";
   * bez niej `detected: false` znaczy naraz „nie ma listy" i „jest, ale nie po naszemu".
   */
  nearMiss: NearMiss[];
  /** Znaki tekstu kart — obok `chars` całości mówi, ile strony w ogóle da się kluczować kartą. */
  cardChars: number;
}

/** Puste rozliczenie kart — ścieżki bez podziału po DOM-ie wypełniają nim wynik. */
const NO_CARDS = (): Pick<DomSegmentation, "cards" | "cardHashes" | "detected" | "cardChars"> =>
  ({ cards: 0, cardHashes: [], detected: false, cardChars: 0 });

const charsOf = (blocks: Block[], hashes: Set<string>): number =>
  blocks.filter((b) => hashes.has(b.hash)).reduce((n, b) => n + b.chars, 0);

const visibleLines = (s: string): string[] =>
  s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * SAMOKONTROLA: czy pocięta strona to nadal ta sama strona.
 *
 * Blok ma być fragmentem tego, co potok i tak wysłałby do modelu. Wstawienie znacznika
 * potrafi to złamać — html-to-text renderuje kontekstowo i jeden tekstowy węzeł w złym
 * miejscu przestawia łamanie linii. Wtedy tekst bloku nie występuje na stronie, jego hash
 * nie trafi nigdy w cache, a model dostanie treść w innym kształcie niż zwykle.
 *
 * Dlatego porównujemy CIĄG widocznych wierszy przed i po. Gdy się nie zgadza, wynik idzie
 * do kosza i zostaje podział po akapitach: gorszy, ale nigdy niepoprawny. Bez tej kontroli
 * błąd z komórkami tabeli wyglądałby po prostu na „DOM tu nie pomaga".
 */
function assertSameLines(clean: string, blocks: Block[]): string | null {
  const a = visibleLines(clean);
  const b = visibleLines(blocks.map((x) => x.text).join("\n\n"));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `wiersz ${i}: strona ma ${JSON.stringify((a[i] ?? "—").slice(0, 80))}, `
        + `bloki mają ${JSON.stringify((b[i] ?? "—").slice(0, 80))}`;
    }
  }
  return null;
}

/** Otacza kartę parą znaczników — treść między nimi wyjdzie z renderu jako gotowy blok. */
function mark(el: Element): void {
  const siblings = el.parent?.children;
  if (!siblings) return;
  const open = new Text(`\n\n${MARK}\n\n`);
  const close = new Text(`\n\n${MARK}\n\n`);
  open.parent = close.parent = el.parent;
  siblings.splice(siblings.indexOf(el), 1, open, el, close);
}

/** Tekst z znacznikami → bloki. Nieparzyste kawałki to karty, parzyste — reszta strony. */
function cut(marked: string): { blocks: Block[]; cardHashes: string[] } {
  const blocks: Block[] = [];
  const cardHashes: string[] = [];
  for (const [i, part] of marked.split(MARK_SPLIT).entries()) {
    if (i % 2 === 1) {
      const text = part.trim();
      if (text) {
        const block = toBlock(text);
        blocks.push(block);
        cardHashes.push(block.hash);
      }
      continue;
    }
    // reszta strony: nagłówki sekcji, opisy, stopki treściowe — tną się po akapitach,
    // więc zmiana w jednym miejscu nie unieważnia całego marginesu
    blocks.push(...segment(part));
  }
  return { blocks, cardHashes };
}

/**
 * Podział HTML-a na bloki. Suma tekstów bloków pokrywa całą stronę — karty osobno,
 * reszta pocięta po akapitach (bo „wszystko poza kartami" bywa połową dokumentu).
 */
export function segmentHtml(html: string): DomSegmentation {
  const doc = parseDocument(html);
  prune(doc);

  const cards: Element[] = [];
  const nearMiss: NearMiss[] = [];
  for (const c of doc.children) collectCards(c, cards, nearMiss);
  if (!cards.length) {
    // brak listy — dokładnie dzisiejsze zachowanie, bez udawania struktury
    return { blocks: segment(toText(render(doc))), ...NO_CARDS(), thinned: 0, nearMiss };
  }
  // odchudzanie PRZED wzorcem samokontroli: `clean` ma być tą stroną, którą naprawdę
  // wysyłamy, inaczej porównanie wierszy odrzucałoby każdą stronę z powtórkami w karcie
  let thinned = 0;
  for (const el of cards) thinned += thinCard(el);

  // render bez znaczników — wzorzec dla samokontroli i wynik ścieżki zapasowej
  const clean = toText(render(doc));

  for (const el of cards) mark(el);
  const { blocks, cardHashes } = cut(toText(render(doc)));
  const diverged = assertSameLines(clean, blocks);
  if (diverged !== null) {
    return {
      blocks: segment(clean), ...NO_CARDS(), thinned, nearMiss,
      perturbed: true, perturbedAt: diverged,
    };
  }
  return {
    blocks, cards: cardHashes.length, cardHashes, detected: true, thinned, nearMiss,
    cardChars: charsOf(blocks, new Set(cardHashes)),
  };
}
