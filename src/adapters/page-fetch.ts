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

export type Fetched = {
  kind: "html" | "pdf" | "skip" | "not-modified" | "feed";
  text: string;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
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
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "nav", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "footer", format: "skip" },
    ],
  });
  return { kind: "html", text, httpStatus: status, ...v };
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
    return { kind: "html", text: htmlToText(html, { wordwrap: false }), httpStatus: status };
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
