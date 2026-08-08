/**
 * Raport z pomiaru powtarzalności treści (`npm run measure-reuse`).
 *
 * Publikowany razem z resztą metryk, więc NIE MA W NIM ANI ZNAKU TREŚCI STRON — tylko
 * liczby, hashe i ścieżki. Przykłady (fragmenty, które faktycznie poszłyby do modelu)
 * lądują w PRYWATNYM archiwum pod `reuse/<źródło>.json` i panel dociąga je przez most
 * na localhoście, tak samo jak zrzuty `raw/`. Dokładnie ten sam podział, co wszędzie
 * indziej: publiczne repo dostaje pomiar, treść zostaje w buckecie.
 */

/** Jedno porównanie dzień-do-dnia dla jednego źródła. */
export interface ReusePair {
  /** dzień PÓŹNIEJSZY z pary — ten, za który płacilibyśmy */
  day: string;
  /** dzień, z którym porównujemy (poprzedni zrzut, niekoniecznie wczorajszy) */
  prev: string;
  chars: number;
  blocks: number;
  newBlocks: number;
  newChars: number;
  /** udział znaków obecnych w poprzednim zrzucie — sufit dla dowolnej segmentacji */
  ceiling: number;
  /** udział znaków w blokach, które cache już znał */
  reuse: number;
  /** koszt LLM tego źródło-dnia wg runs.json; brak = dzień spoza retencji raportów */
  usd?: number;
}

export interface ReuseSource {
  id: string;
  /** zrzuty followupów mają własny wpis — cache mają osobny, więc i pomiar musi być osobny */
  followup: boolean;
  days: number;
  chars: number;
  ceiling: number;
  reuse: number;
  /** dni, w których ANI JEDEN blok nie był nowy — wywołanie modelu w ogóle by nie poszło */
  freeDays: number;
  /** koszt tych dni: o tyle rachunek spadłby na pewno */
  freeUsd: number;
  /** koszt dni częściowo zmienionych, przeskalowany odzyskiem — szacunek */
  shrinkUsd: number;
  pairs: ReusePair[];
  /** ścieżka do przykładów w prywatnym archiwum; brak = archiwum było niedostępne przy zapisie */
  samples?: string;
}

export interface ReuseReport {
  generated: string;
  /** okno pomiaru */
  from: string;
  to: string;
  days: number;
  /** parametry segmentacji — bez nich procenty nie znaczą nic konkretnego */
  segment: { maxChars: number; targetParas: number };
  totals: {
    chars: number;
    pairs: number;
    ceiling: number;
    reuse: number;
    freeDays: number;
    freeUsd: number;
    shrinkUsd: number;
  };
  sources: ReuseSource[];
}

/** Przykłady dla jednego źródła — WYŁĄCZNIE do prywatnego archiwum. */
export interface ReuseSamples {
  id: string;
  generated: string;
  pairs: {
    day: string;
    prev: string;
    /** fragmenty, które mimo cache'a poszłyby do modelu */
    newBlocks: { hash: string; chars: number; text: string }[];
    /** ile bloków pominięto w przykładzie (przykład ma ilustrować, nie archiwizować) */
    omitted: number;
  }[];
}
