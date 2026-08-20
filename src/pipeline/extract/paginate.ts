/**
 * Adres NASTĘPNEJ STRONY listingu — odczytany ze strony, nie zgadnięty z nazwy parametru.
 *
 * `shared/url-template.ts` zgaduje: trzyma listę `PAGE_PARAMS` (`page`, `p`, `strona`…)
 * i szuka jej w adresach. Pomiar 2026-08-20 na 35 źródłach nie-FB pokazał, czemu to nie
 * wystarcza — siedem pagerów, pięć konwencji, z czego dwie spoza tamtej listy i nie do
 * przewidzenia, bo to nazwy jednego CMS-a:
 *
 *   /wydarzenia?pno=2                          oklubon.pl
 *   /wydarzenia?ccm_paging_p=2&ccm_order_by=…  puszczykowo.pl (Concrete CMS)
 *   https://www.mosina.pl/wydarzenia?page=2    mosina.pl
 *   https://biblub.com/page/2/                 biblub.com
 *   <link rel="next">                          bracz.edu.pl (WordPress)
 *
 * Adres strony 2 stoi w HTML-u każdej z nich, więc go CZYTAMY. Lista nazw parametrów byłaby
 * listą wyjątków per CMS — dokładnie tym kształtem, którego ten potok unika.
 *
 * NUMER BIEŻĄCEJ STRONY PODAJE WYWOŁUJĄCY, a nie zgadujemy go z klasy `active`: pętla
 * paginacji i tak wie, którą stronę właśnie czyta, a każdy CMS oznacza bieżący numer inaczej
 * (`<strong>`, `li.active`, `aria-current`, `span.current` — wszystkie cztery w próbce wyżej).
 */
import { type AnyNode, type Element, hasChildren, isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";

import { type Fetched, fetchPlain, validators } from "../../adapters/page-fetch.js";
import { archiveRaw } from "../../adapters/supabase-archive.js";
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { todayIso } from "../../shared/dates.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import { urlKey } from "../../shared/url.js";
import type { EventItem, PageRun, PipelineState, Source, SourceRun } from "../../types/index.js";

import { fetchableUrls } from "../repertoire.js";

import { detach } from "./block-cache.js";
import { blockSource } from "./block-source.js";
import { extractEvents } from "./extract.js";
import { groundFollowups } from "./followup-url.js";

/** Wyżej niż tyle numer w pagerze nie sięga; większa liczba to rok albo licznik odsłon. */
const MAX_PAGE = 500;

/** Wszystkie elementy o danym znaczniku, w kolejności dokumentu. */
function descendants(root: AnyNode, tag: string, out: Element[] = []): Element[] {
  if (isTag(root) && root.tagName === tag) out.push(root);
  if (hasChildren(root)) for (const c of root.children) descendants(c, tag, out);
  return out;
}

/** Czy element ma gdzieś nad sobą tabelę — patrz `isCalendar`. */
function inTable(el: Element): boolean {
  for (let p = el.parent; p; p = p.parent) if (isTag(p) && p.tagName === "table") return true;
  return false;
}

/**
 * KALENDARZ UDAJĄCY PAGER — jedyna pomyłka, która nie kosztuje jednej strony, tylko trzydzieści.
 *
 * poznan.pl/mim/events wypisuje siatkę dni miesiąca: `<td><a href="/mim/events/2026-08-02/">2</a>`.
 * Numer dnia wygląda jak numer strony co do znaku, a adres prowadzi do INNEGO DNIA, nie do
 * dalszej części tej samej listy. Rozstrzygają dwie rzeczy naraz, bo każda z osobna ma dziurę:
 *
 *   1. siatka kalendarza stoi w `<table>`, pager nigdy (to samo rozumowanie, co `NOT_A_CARD`
 *      w dom-blocks.ts — tabela renderuje się inaczej niż lista i znaczy co innego);
 *   2. numer odnośnika jest DNIEM daty stojącej w jego adresie. To wyklucza kalendarz, a nie
 *      wyklucza paginacji dziennego listingu (`/wydarzenia/2026-08-20?page=2` ma w adresie
 *      datę, ale jej dzień to 20, a nie 2).
 */
function isCalendar(a: Element, n: number): boolean {
  if (inTable(a)) return true;
  const dzien = /(?:19|20)\d\d-(\d{2})-(\d{2})/u.exec(a.attribs["href"] ?? "");
  return dzien !== null && Number(dzien[2]) === n;
}

/** Numer, którym podpisany jest odnośnik — albo `null`, gdy to nie jest goła liczba. */
function numberOf(a: Element): number | null {
  const t = textContent(a).trim();
  if (!/^\d{1,3}$/u.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_PAGE ? n : null;
}

/** Adres bezwzględny; `null`, gdy href jest pusty, kotwicą albo nie da się go rozwinąć. */
function resolve(href: string | undefined, base: string): string | null {
  const raw = (href ?? "").trim();
  if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

/**
 * `<link rel="next">` — i WYŁĄCZNIE `<link>`, nigdy `<a rel="next">`.
 *
 * To nie jest ostrożność, tylko poprawka na fałszywe trafienie z 2026-08-20:
 * `gazeta-lubon.pl/2026/losir-kalendarium` niesie `<a rel="next">` prowadzące do
 * „XXI sesji Rady Miasta Luboń" — WordPress podpisuje tak nawigację między WPISAMI.
 * Paginacja poszłaby stamtąd w losowy artykuł, a z niego w następny, bez końca.
 * `<link rel="next">` w nagłówku jest zdaniem o TYM dokumencie i jego dalszej części
 * (tak robi Yoast dla archiwów) i tylko ono coś o liście mówi.
 */
function relNext(doc: AnyNode, base: string): string | null {
  for (const el of descendants(doc, "link")) {
    if (!/(^|\s)next(\s|$)/iu.test(el.attribs["rel"] ?? "")) continue;
    const url = resolve(el.attribs["href"], base);
    if (url) return url;
  }
  return null;
}

/**
 * Adres strony `current + 1` albo `null`, gdy dalszej strony nie da się ODCZYTAĆ.
 *
 * `null` znaczy „koniec drogi", a nie „na pewno nie ma dalej": okpoznan.pl ma pager
 * z czterema numerami i ZERO adresów — numer dokłada JS w wywołaniu AJAX. Zgadywanie
 * adresu byłoby wtedy wróżeniem z nazwy parametru, którego w HTML-u nie ma ani razu.
 * Wywołujący ma to zameldować w śladzie i zostać przy stronie pierwszej.
 */
export function nextPageUrl(html: string, pageUrl: string, current: number): string | null {
  const doc = parseDocument(html);
  const szukany = current + 1;

  for (const a of descendants(doc, "a")) {
    if (numberOf(a) !== szukany || isCalendar(a, szukany)) continue;
    const url = resolve(a.attribs["href"], pageUrl);
    // ten sam adres, co czytany przed chwilą, to pager wskazujący sam na siebie — pętla
    if (url && url !== pageUrl) return url;
  }
  return relNext(doc, pageUrl);
}

/**
 * Miesiące po polsku, po RDZENIU — odmiana („marca", „września", „październiku") jest tu
 * regułą, nie wyjątkiem, a lista pełnych form byłaby listą przypadków gramatycznych.
 * Kolejność wyznacza numer miesiąca, więc nie wolno jej ruszać.
 */
const MIESIACE = [
  "stycz", "lut", "mar", "kwiet", "maj", "czerw",
  "lip", "sierp", "wrze", "paździer|pazdzier", "listopad", "grud",
];

/**
 * Treść widziana OCZAMI SONDY: bez adresów.
 *
 * `biblub.com/wp-content/uploads/2026/09/foto.jpg` niesie katalog publikacji, który wygląda
 * jak termin — a stoi przy wpisie z maja. Gdyby liczył się jak data, archiwum udawałoby
 * stronę z przyszłością i płacilibyśmy za nie codziennie. Wypada też tekst w nawiasach
 * kwadratowych, bo tak `html-to-text` renderuje odnośniki (patrz adapters/page-fetch.ts).
 */
const bezAdresow = (text: string): string =>
  text.normalize("NFKC").replace(/\[[^\]]*\]/gu, " ").replace(/https?:\/\/\S+/gu, " ");

/** Wszystkie KONKRETNE terminy z treści (ISO). Data bez roku się nie liczy — patrz `worthReading`. */
export function pageDates(text: string): string[] {
  const t = bezAdresow(text);
  const out: string[] = [];
  const dodaj = (rok: string, mies: number, dzien: string): void => {
    const d = Number(dzien);
    if (mies >= 1 && mies <= 12 && d >= 1 && d <= 31) {
      out.push(`${rok}-${String(mies).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  };
  for (const m of t.matchAll(/\b(20\d\d)-(\d{2})-(\d{2})\b/gu)) dodaj(m[1]!, Number(m[2]), m[3]!);
  for (const m of t.matchAll(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d\d)\b/gu)) dodaj(m[3]!, Number(m[2]), m[1]!);
  for (const [i, mies] of MIESIACE.entries()) {
    const re = new RegExp(`\\b(\\d{1,2})\\s+(?:${mies})[a-ząćęłńóśźż]*\\s+(20\\d\\d)\\b`, "giu");
    for (const m of t.matchAll(re)) dodaj(m[2]!, i + 1, m[1]!);
  }
  return out.sort();
}

/** Werdykt sondy — razem ze zdaniem do śladu, bo „read: false" samo z siebie nic nie tłumaczy. */
export interface PageVerdict {
  read: boolean;
  why: string;
}

/**
 * Czy za tę stronę warto zapłacić wywołanie modelu — DARMOWA sonda po samych datach.
 *
 * Rozstrzyga porządek sortowania serwisu, nie jego adres: kalendarz rosnąco trzyma na stronie
 * 2 PÓŹNIEJSZE wydarzenia (mosina, puszczykowo, poznan.pl), a blog aktualności — STARSZE wpisy
 * (biblub: strona 2 to zakres 2024-06…2026-05, ani jednej przyszłej daty). Pobranie HTTP nic
 * nie kosztuje, więc pytamy o to PRZED wywołaniem, a nie po nim.
 *
 * BRAK DAT CZYTAMY MIMO WSZYSTKO. Asymetria jest jednostronna: pominięta strona kosztuje cały
 * swój listing (oklubon.pl ma na stronie 2 dwadzieścia trzy nowe wpisy i ani jednej daty
 * w treści, bo terminy stoją dopiero na podstronach), a zbędne wywołanie kosztuje ~$0,0015.
 *
 * Daty BEZ ROKU („21.08") celowo się nie liczą: rok trzeba by dopowiedzieć, a dopowiedziany
 * rok bieżący zamieniłby archiwum sprzed dwóch lat w stronę pełną przyszłości.
 */
export function worthReading(text: string, today: string): PageVerdict {
  const daty = pageDates(text);
  if (!daty.length) return { read: true, why: "w treści nie ma dat — czytamy, żeby nie zgubić listy" };
  const przyszle = daty.filter((d) => d >= today).length;
  if (przyszle) {
    return { read: true, why: `${przyszle} z ${daty.length} terminów w przyszłości` };
  }
  return {
    read: false,
    why: `${daty.length} terminów i ani jednego w przyszłości (${daty[0]}…${daty[daty.length - 1]})`,
  };
}

/**
 * PĘTLA PO DALSZYCH STRONACH LISTINGU.
 *
 * Trzecia droga do tego samego źródła, obok strony pierwszej i followupów — i celowo NIE
 * followup: podstrona wydarzenia i strona 2 listingu to dwa różne zwierzęta, więc mają dwa
 * różne sufity. Wrzucone do jednej kolejki, paginacja zjadałaby sloty podstronom (widać to
 * w przebiegach 18–20.08: `dopiewo.pl/wydarzenia?page=1` zajmowało slot followupa co dzień).
 *
 * Chodzenie kończy się na PIERWSZYM z pięciu warunków, bo każdy znaczy „dalej nie ma nic,
 * za co warto zapłacić":
 *
 *   1. sufit `LISTING_PAGES_MAX`;
 *   2. pagera nie da się odczytać (okpoznan.pl: cztery numery, zero adresów — dokłada je JS);
 *   3. serwer odpowiedział 304 — treści nie mamy, więc nie ma z czego wziąć kolejnego adresu;
 *   4. darmowa sonda dat nie widzi ani jednego przyszłego terminu (biblub.com/page/2 to
 *      archiwum 2024-06…2026-05) — i wtedy NIE płacimy za tę stronę ani centa;
 *   5. strona nie oddała ani jednego wydarzenia — dalsze będą z tej samej beczki.
 */

/** Tyle, ile pętla musi wiedzieć o źródle i o przebiegu, który właśnie rozlicza. */
export interface PagesCtx {
  src: Source;
  state: PipelineState;
  /** raport źródła — pętla dopisuje do niego `pages` */
  run: SourceRun;
  /** HTML strony, na której właśnie stoimy; bez niego nie ma skąd wziąć adresu następnej */
  html: string | undefined;
  pageUrl: string;
}

/** Wynik jednej strony: co wnosi do źródła i czy jest sens iść dalej. */
interface PageStep {
  events: EventItem[];
  followups: string[];
  /** HTML tej strony — wejście do odczytania pagera następnej; `undefined` kończy chodzenie */
  html: string | undefined;
}

const KONIEC: PageStep = { events: [], followups: [], html: undefined };

/** Klucz cache'u strony listingu — ten sam schemat, co u followupów (znormalizowany adres). */
const pageKey = (url: string): string => urlKey(url);

/** Odczyt treści: ścieżką blokową, a gdy ta odmówi — jednym wywołaniem na całość. */
async function readPage(got: Fetched, url: string, state: PipelineState, pr: PageRun):
Promise<{ events: EventItem[]; followups: string[] }> {
  const viaBlocks = await blockSource(got, url, state);
  if (viaBlocks) {
    pr.blocks = viaBlocks.blocks;
    return { events: viaBlocks.events, followups: ground(viaBlocks.followups, url, got.html) };
  }
  const result = await extractEvents(got.text, url);
  return {
    events: [...(result.events ?? [])],
    followups: ground((result.followups ?? []).map((f) => f.url), url, got.html),
  };
}

/**
 * Followupy z dalszej strony przechodzą DOKŁADNIE te same bramki, co te ze strony pierwszej —
 * inwentarz odnośników i odsiew repertuaru — tyle że wobec WŁASNEJ strony.
 *
 * To nie jest ostrożność na zapas: `groundFollowups` odrzuca adres z tego serwisu, którego nie
 * ma na czytanej stronie (fail closed na sklejanie przez model), więc puszczenie propozycji ze
 * strony 2 przez inwentarz strony 1 skasowałoby je co do jednej.
 */
const ground = (urls: string[], url: string, html: string | undefined): string[] =>
  fetchableUrls(groundFollowups(urls, url, html));

/**
 * Jedna dalsza strona: pobranie, trzy odsiewy i ewentualne wywołanie modelu.
 * `html: undefined` w wyniku znaczy „nie idziemy dalej" — patrz warunki w nagłówku sekcji.
 */
async function pullPage(
  next: string, pr: PageRun, ctx: PagesCtx, today: string,
): Promise<PageStep> {
  const { src, state } = ctx;
  const cache = (state.extractions ??= {});
  const key = pageKey(next);
  const cached = cache[key];

  let got: Fetched;
  try {
    got = await fetchPlain(next, validators(cached));
  } catch (e) {
    pr.outcome = "error";
    pr.why = describeError(e);
    audit("page", `strona ${pr.page} nieudana: ${pr.why}`, { url: next, page: pr.page });
    return KONIEC;
  }

  if (got.kind === "not-modified") {
    pr.outcome = "unchanged";
    pr.events = cached?.events.length ?? 0;
    audit("page", `strona ${pr.page} bez zmian (304) — ${pr.events} wydarzeń z cache`,
      { url: next, page: pr.page, events: pr.events });
    return { events: detach(cached?.events ?? []), followups: [], html: undefined };
  }

  const hash = sha256(got.text);
  if (cached?.hash === hash) {
    cache[key] = { ...cached, at: new Date().toISOString() };
    pr.outcome = "unchanged";
    pr.events = cached.events.length;
    audit("page", `strona ${pr.page}: ten sam hash treści — ${pr.events} wydarzeń z cache, bez modelu`,
      { url: next, page: pr.page, events: pr.events });
    return { events: detach(cached.events), followups: [], html: got.html };
  }

  // DARMOWA SONDA PRZED PŁATNYM WYWOŁANIEM — patrz `worthReading`
  const verdict = worthReading(got.text, today);
  pr.why = verdict.why;
  if (!verdict.read) {
    pr.outcome = "stale";
    audit("page", `strona ${pr.page} pominięta bez wywołania modelu: ${verdict.why}`,
      { url: next, page: pr.page, why: verdict.why });
    return KONIEC;
  }

  await archiveRaw(`${src.id}__page${pr.page}`, next, got.text, got.kind);
  const read = await readPage(got, next, state, pr);
  cache[key] = { hash, events: detach(read.events), at: new Date().toISOString() };
  pr.events = read.events.length;
  audit("page", `strona ${pr.page} → ${read.events.length} wydarzeń (${verdict.why})`,
    { url: next, page: pr.page, events: read.events.length, why: verdict.why });
  // strona bez ani jednego wydarzenia kończy chodzenie: dalsze będą z tej samej beczki
  return { ...read, html: read.events.length ? got.html : undefined };
}

/**
 * Wydarzenia i propozycje followupów z DALSZYCH stron listingu. Nie rusza strony pierwszej —
 * tę przeczytał już `processSource`, a tutaj zaczynamy od jej pagera.
 */
export async function runPages(ctx: PagesCtx): Promise<{ events: EventItem[]; followups: string[] }> {
  const events: EventItem[] = [];
  const followups: string[] = [];
  const max = P.LISTING_PAGES_MAX.get();
  const today = todayIso();
  let html = ctx.html;
  let url = ctx.pageUrl;

  for (let page = 2; page <= max; page++) {
    const next = html ? nextPageUrl(html, url, page - 1) : null;
    if (!next) {
      // milczymy przy stronie bez pagera (to norma) — meldujemy tylko pager, który JEST,
      // ale nie niesie adresów, bo to jedyny przypadek, w którym coś naprawdę tracimy
      if (page === 2 && html && /js_ajax_box_page|pagination|paggination/iu.test(html)) {
        audit("page", "pager na stronie jest, ale bez adresów — numer dokłada JS, "
          + "więc zostajemy przy pierwszej stronie", { url, pages: 1 });
      }
      break;
    }
    const pr: PageRun = { page, url: next, outcome: "ok", events: 0 };
    ctx.run.pages = [...(ctx.run.pages ?? []), pr];

    const step = await pullPage(next, pr, ctx, today);
    events.push(...step.events);
    followups.push(...step.followups);
    if (!step.html) break;
    html = step.html;
    url = next;
  }
  return { events, followups };
}
