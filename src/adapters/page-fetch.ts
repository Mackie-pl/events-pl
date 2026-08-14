/**
 * Pobieranie stron źródeł: zwykły fetch, przeglądarka bezgłowa i plakaty jako base64.
 *
 * Licznik pobrań jest modułowy i ŚWIADOMIE osobny od liczników innych adapterów:
 * do costs.json trafia kategoria `scrape`, a wrzucenie tu jednego wspólnego licznika
 * wliczyłoby do niej wywołania OpenRoutera, Supabase i Telegrama.
 */
import { convert as htmlToText } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";

import type { CachedExtraction } from "../types/index.js";

import { BROWSER_HEADERS, fetchUrl } from "./http.js";

/**
 * Wolumen sieciowy przebiegu. Pobrania i geokodowanie są dziś darmowe (GH Actions dla repo
 * publicznego, Nominatim), ale „darmowe" znaczy „zero do limitu" — bez zapisanego wolumenu
 * pierwszy rachunek za przekroczenie albo pierwszy ban od Nominatima są niespodzianką.
 * Liczy tylko żądania, które faktycznie poszły w sieć (304 też, cache — nie).
 */
let fetches = 0;

/**
 * Co wycinamy przed wysłaniem strony do modelu. Wyłącznie ELEMENTY SEMANTYCZNE i role ARIA —
 * żadnego zgadywania po klasach czy id, i to jest tu najważniejsza decyzja.
 *
 * Pomiar 2026-08-01 na dziesięciu prawdziwych stronach z rejestru. Wariant z `[class*=nav]`
 * i `[class*=menu]` wyglądał najlepiej ze wszystkich — treść poznan.pl kurczyła się o 50%,
 * kultura.poznan.pl o 40% — dopóki nie policzyło się linków do wydarzeń w wyniku: spadały
 * z 1 na 0. CMS poznan.pl trzyma listę wyników w kontenerze z „nav" w nazwie klasy, więc
 * te 50% to był ŁADUNEK, nie opakowanie. Dwa źródła zamieniłyby się w jałowe dokładnie tak,
 * jak te, które właśnie naprawiliśmy, tylko trudniej byłoby to powiązać z przyczyną.
 *
 * `header` przeszedł osobny test, bo bywa opakowaniem tytułu artykułu (`article > header > h1`):
 * na siedmiu stronach pojedynczych wydarzeń nie zgubił ANI JEDNEGO tytułu, a na dwóch dał
 * największy pojedynczy zysk (bibliotekamosina.pl: 5938 → 4334 znaków).
 *
 * Zysk jest skromny i zależy od typu strony: ~1% na stronach-listach, ~13% na stronach
 * pojedynczych wydarzeń (followupach), gdzie chrom stanowi większość dokumentu.
 */
const TEXT_SELECTORS = [
  { selector: "a", options: { ignoreHref: false } },
  { selector: "nav", format: "skip" },
  { selector: "script", format: "skip" },
  { selector: "style", format: "skip" },
  { selector: "noscript", format: "skip" },
  { selector: "footer", format: "skip" },
  { selector: "header", format: "skip" },
  { selector: "aside", format: "skip" },
  { selector: "[role=navigation]", format: "skip" },
  { selector: "[role=banner]", format: "skip" },
  { selector: "[role=contentinfo]", format: "skip" },
  { selector: "[role=search]", format: "skip" },
];

/**
 * `data:` URI bez ŁADUNKU — zostaje sam typ MIME.
 *
 * html-to-text renderuje obrazek jako „alt [src]", więc obrazek wklejony w stronę base64-em
 * wchodzi do tekstu W CAŁOŚCI. Pomiar na mosina.pl (2026-08-12, strona pojedynczego wydarzenia
 * `szeroko-na-waskiej-2026-1`): 1 046 664 bajtów HTML-a, z czego 640 938 to DWA
 * `data:image/jpeg;base64`. Po konwersji 648 279 znaków tekstu — ucięte do MAX_INPUT_CHARS
 * i wysłane modelowi po JEDNO wydarzenie. Base64 tokenizuje się fatalnie (~1 znak/token),
 * więc samo to źródło zjadło 84 488 tokenów wejścia ($0.096): 12% rachunku CAŁEGO dnia.
 *
 * Wycinamy ładunek, a nie cały adres: `[data:image/jpeg]` zostaje w tekście jako ślad, że stał
 * tu obrazek. Zwykłe `src` zostają nietknięte i to jest tu ważne — followupy-plakaty biorą się
 * właśnie z adresów obrazków w tekście, więc wycięcie ich wszystkich (`linkBrackets: false`)
 * kupiłoby te same znaki kosztem całej ścieżki plakatowej.
 */
const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)[^\s"'<>)]*/gi;

/**
 * Jedno przejście HTML → tekst dla WSZYSTKICH ścieżek pobrania.
 *
 * Eksportowane, bo podział na bloki po DOM-ie (extract/dom-blocks.ts) renderuje każdy
 * fragment osobno i MUSI robić to tą samą funkcją. Gdyby miał własną, tekst bloku różniłby
 * się od tekstu tego samego fragmentu w całej stronie — a to hasze bloków, więc cache
 * chybiałby zawsze i nikt by nie zgadł dlaczego. Z tego samego powodu odchudzanie `data:`
 * siedzi TUTAJ, a nie przy wywołaniu modelu: inaczej hasze bloków niosłyby base64, a model
 * dostawałby coś innego, niż mówi klucz cache'a.
 */
export const toText = (html: string): string =>
  htmlToText(html.replace(DATA_URI, "data:$1"), { wordwrap: false, selectors: TEXT_SELECTORS });

export type Fetched = {
  kind: "html" | "pdf" | "skip" | "not-modified" | "feed";
  text: string;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
  /**
   * Surowy HTML — WYŁĄCZNIE do podziału na bloki (extract/dom-blocks.ts), który potrzebuje
   * struktury, a `text` ją już stracił. Nie idzie do modelu, nie idzie do archiwum
   * (archiwum trzyma to, co dostał model) i nie przeżywa przebiegu.
   *
   * Puste dla PDF-ów, feedów i 304 — tam podział po DOM-ie i tak nie ma czego szukać,
   * a wywołujący schodzi wtedy na podział po akapitach.
   */
  html?: string;
  /**
   * GOTOWY podział na bloki, gdy źródło zna go lepiej niż segmentacja — dziś wyłącznie
   * grupy FB, gdzie Bright Data oddaje tablicę postów i granica jest dana, nie zgadywana
   * (patrz `fbGroupPostsToBlocks`). Ta sama rola co `html` wyżej: niesie strukturę, którą
   * `text` stracił, wyłącznie na użytek podziału.
   *
   * Niezmiennik: `blocks.join()` musi dawać `text` co do znaku — z `text` liczy się hash
   * źródła i dowód bezpiecznika, więc rozjazd tych dwóch cicho zerwałby cache i ślad.
   */
  blocks?: string[];
};

/**
 * Nagłówki warunkowe z cache. Gdy serwer je obsługuje, odpowiada 304 i nie przesyła treści —
 * najtańszy możliwy sposób stwierdzenia, że plakat/PDF się nie zmienił.
 */
export function validators(c?: CachedExtraction): Record<string, string> {
  const h: Record<string, string> = {};
  if (c?.etag) h["If-None-Match"] = c.etag;
  if (c?.lastModified) h["If-Modified-Since"] = c.lastModified;
  return h;
}

const validatorsOf = (res: Response): { etag?: string; lastModified?: string } => {
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
};

/** Błąd HTTP niosący kod statusu, żeby raport mógł go pokazać nawet przy porażce. */
export function httpError(status: number, url: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${url}`), { httpStatus: status });
}

export async function fetchPlain(url: string, extraHeaders: Record<string, string> = {}): Promise<Fetched> {
  fetches += 1;
  const res = await fetchUrl(url, { headers: { ...BROWSER_HEADERS, ...extraHeaders } }, 30_000);
  if (res.status === 304) return { kind: "not-modified", text: "", httpStatus: 304 };
  if (!res.ok) throw httpError(res.status, url);
  const status = res.status;
  const v = validatorsOf(res);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    // unpdf nie eksportuje typu PDFDocumentProxy, więc dla tseslinta to „error type". tsc to
    // przepuszcza, bo extractText przyjmuje dokładnie to, co zwraca getDocumentProxy.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- brak typu w unpdf
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return { kind: "pdf", text, httpStatus: status, ...v };
  }
  const html = await res.text();
  return { kind: "html", text: toText(html), html, httpStatus: status, ...v };
}

/**
 * Treść BEZ przepuszczania przez html-to-text — dla wyjść maszynowych (JSON `tribe`, iCal).
 * Osobna funkcja, a nie flaga w fetchPlain: konwersja na tekst jest tam sensownym domyślnym
 * zachowaniem dla stron, a `htmlToText` na JSON-ie potrafi zjeść nawiasy i pozrywać klucze.
 * Reszta (licznik pobrań, walidatory, 304, httpError) jest wspólna i celowo identyczna.
 */
export async function fetchRaw(url: string, extraHeaders: Record<string, string> = {}): Promise<Fetched> {
  fetches += 1;
  const res = await fetchUrl(url, { headers: { ...BROWSER_HEADERS, ...extraHeaders } }, 30_000);
  if (res.status === 304) return { kind: "not-modified", text: "", httpStatus: 304 };
  if (!res.ok) throw httpError(res.status, url);
  return { kind: "feed", text: await res.text(), httpStatus: res.status, ...validatorsOf(res) };
}

export async function fetchHeadless(url: string): Promise<Fetched> {
  // playwright jest optionalDependency — dynamiczny import przez zmienną,
  // żeby typecheck przechodził bez zainstalowanego pakietu
  interface MinimalResponse { status(): number }
  interface MinimalPage {
    goto(u: string, o: { waitUntil: string; timeout: number }): Promise<MinimalResponse | null>;
    content(): Promise<string>;
  }
  interface MinimalBrowser { newPage(): Promise<MinimalPage>; close(): Promise<void> }
  const modName = "playwright";
  fetches += 1;
  const { chromium } = (await import(modName)) as { chromium: { launch(): Promise<MinimalBrowser> } };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const status = resp?.status() ?? 0;
    if (status >= 400) throw httpError(status, url);
    const html = await page.content();
    // ta sama konwersja co w fetchPlain. Wcześniej headless leciał BEZ selektorów, więc
    // ścieżka ratunkowa po 403 wysyłała do modelu menu i stopkę, których zwykła nie wysyłała —
    // dwie różne treści dla tego samego adresu, zależnie od tego, czy serwis nas odbił
    return { kind: "html", text: toText(html), html, httpStatus: status };
  } finally {
    await browser.close();
  }
}

export type FetchedImage =
  | { notModified: true }
  | { notModified: false; data: string; mediaType: "image/jpeg" | "image/png"; etag?: string; lastModified?: string };

/** Plakat JPG/PNG -> base64 dla modelu wizyjnego. 304 = ten sam plakat, nie pobieramy bajtów. */
export async function fetchImageB64(
  url: string, extraHeaders: Record<string, string> = {},
): Promise<FetchedImage | null> {
  fetches += 1;
  const res = await fetchUrl(url, { headers: { ...BROWSER_HEADERS, ...extraHeaders } }, 30_000);
  if (res.status === 304) return { notModified: true };
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 5_000_000) return null;
  return {
    notModified: false,
    data: buf.toString("base64"),
    mediaType: /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg",
    ...validatorsOf(res),
  };
}

export const fetchStats = (): number => fetches;
export function resetFetchStats(): void { fetches = 0; }
