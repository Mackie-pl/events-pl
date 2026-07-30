/** Księga kosztów (costs.json): kategorie, stawki, wpisy. */

// ---------------- koszty ----------------

/**
 * Kategoria wydatku. Podział przebiega po tym, **co się psuje osobno**, a nie po
 * dostawcy: „Haiku" w rachunku OpenRoutera to i tekst stron, i plakaty, ale rosną
 * z zupełnie innych powodów i naprawia się je inaczej.
 *
 * Kategorie z zerową stawką (`search`, `scrape`, `geo`, `storage`) też są zapisywane:
 * darmowy tier to nie brak kosztu, tylko koszt zero **do limitu** — bez zapisanego
 * wolumenu pierwszy rachunek za przekroczenie jest niespodzianką.
 */
export type CostCategory =
  | "llm-extract" // Haiku: tekst strony/PDF-a (etap 2)
  | "llm-vision" // Haiku multimodal: plakaty JPG/PNG (etap 2)
  | "llm-discover" // Sonnet: triage kandydatów (etap 1)
  | "llm-verify" // Haiku: naprawa martwych URL-i (etap 1)
  | "fb" // Bright Data: rekordy (wydarzenia FB + posty grup)
  | "search" // wyszukiwarka: zapytania (Google CSE 100/dzień gratis, Brave 2000/mies.)
  | "scrape" // pobrania HTTP + headless (własna maszyna / Actions)
  | "geo" // Nominatim: zapytania sieciowe (darmowe, 1 req/s)
  | "storage"; // Supabase Storage: wysłane obiekty (darmowy tier ~1 GB)

export type CostUnit = "calls" | "records" | "queries" | "fetches" | "lookups" | "MB";

/** Najdroższa pozycja w kategorii — „$0.41 na ekstrakcji" bez tego nie mówi, gdzie szukać. */
export interface CostDriver {
  /** id źródła / gminy — klucz do przebiegu w panelu */
  id: string;
  usd: number;
  units: number;
}

export interface CostEntry {
  /** YYYY-MM-DD (UTC) — oś wykresu */
  day: string;
  at: string;
  stage: "daily" | "discover" | "digest";
  /** startedAt przebiegu — klucz do runs.json / discover-runs.json */
  run: string;
  category: CostCategory;
  usd: number;
  /**
   * false = kwota od dostawcy (OpenRouter zwraca `cost` przy każdym wywołaniu),
   * true = iloczyn wolumenu i stawki z `CostRates` (Bright Data, storage).
   * Bez tego rozróżnienia szacunek po cichu awansuje na fakt.
   */
  estimated: boolean;
  units: number;
  unit: CostUnit;
  tokensIn?: number;
  tokensOut?: number;
  /** kilka najdroższych pozycji (źródła / gminy) — reszta zostaje w raporcie przebiegu */
  top?: CostDriver[];
  /**
   * Kategoria odtworzona ze starego raportu, nie zmierzona przy wywołaniu (backfill).
   * Kwota jest prawdziwa, ale np. plakaty siedzą wtedy w `llm-extract` — przebiegi
   * sprzed podziału na zadania nie miały czym ich odróżnić.
   */
  inferred?: boolean;
}

/**
 * Stawki użyte przy szacunkach. Zapisywane w costs.json razem z wpisami: po zmianie
 * cennika stare wpisy muszą dać się wytłumaczyć stawką, która wtedy obowiązywała.
 */
export interface CostRates {
  /** $ za rekord Bright Data (rząd $1–1.5/1000; potwierdź w panelu BD) */
  bdPerRecord: number;
  /** $ za zapytanie wyszukiwarki ponad darmowy tier (Google: $5/1000 powyżej 100/dzień) */
  searchPerQuery: number;
  /** $ za GB-miesiąc Supabase Storage (darmowy tier ~1 GB) */
  storagePerGbMonth: number;
  /** $ za jedno pobranie HTTP (własny hosting/proxy; GH Actions dla repo publicznego: 0) */
  scrapePerFetch: number;
  /** budżet miesięczny — linia odniesienia w panelu, nie limit twardy */
  monthlyBudgetUsd: number;
}

export interface CostLedger {
  updated: string;
  rates: CostRates;
  /** po ilu dniach wpisy są przycinane */
  retentionDays: number;
  entries: CostEntry[];
}
