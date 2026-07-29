/** Raport przebiegu daily (runs.json). */

import type { CostEntry } from "./cost.js";
import type { FetchStrategy } from "./source.js";
import type { BdUsage, LlmUsage, TaskUsage } from "./usage.js";

// ---------------- observability / run reporting ----------------

export type SourceStatus = "ok" | "unchanged" | "error" | "skipped-fb" | "skipped-dead" | "empty";

export interface FollowupRun {
  url: string;
  kind: "poster" | "page";
  /** unchanged = treść identyczna (304 albo ten sam hash), wydarzenia odtworzone z cache */
  outcome: "ok" | "error" | "unchanged";
  events: number;
  err?: string;
}

/**
 * Tożsamość jednego wydarzenia w obrębie przebiegu — tyle, ile trzeba, by wskazać je
 * w events.json i pokazać w panelu, bez wkładania do runs.json drugiej kopii wszystkich pól.
 * Pełny rekord (sprzed redakcji PII) żyje w prywatnym archiwum z dnia ekstrakcji.
 *
 * Bez tego `SourceRun.events` był samą liczbą: „to źródło dało 10 wydarzeń" — których,
 * wiedziało tylko events.json, i to wyłącznie dla najnowszego przebiegu.
 */
export interface EventRef {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** URL konkretnego wydarzenia — dla followupa inny niż adres źródła */
  url: string;
  /**
   * id źródła, którego rekord wygrał dedupe (bywa nim to samo źródło — duplikat u siebie).
   * Brak = rekord przeszedł do events.json.
   */
  mergedInto?: string;
}

export interface SourceRun {
  id: string;
  name: string;
  town: string;
  url: string;
  fetch: FetchStrategy;
  status: SourceStatus;
  httpStatus?: number;
  kind?: "html" | "pdf";
  /** długość pobranego tekstu */
  chars?: number;
  /** czy hash różnił się od stanu (zmiana treści) */
  changed?: boolean;
  /** wydarzenia zachowane z tego źródła (łącznie z followupami) */
  events: number;
  /**
   * Które to były wydarzenia — stan PRZED dedupe, więc suma po źródłach bywa większa
   * niż events.json. Brak pola = źródło nic nie dało (albo przebieg sprzed tej wersji).
   */
  produced?: EventRef[];
  followups: FollowupRun[];
  geo: { hits: number; misses: number };
  llm: LlmUsage;
  /** ten sam koszt w rozbiciu na zadania — bez tego plakat i tekst są nieodróżnialne */
  llmByTask?: TaskUsage;
  /** zużycie Bright Data przypisane temu źródłu (grupa FB); brak = nie dotykało BD */
  bd?: BdUsage;
  ms: number;
  err?: string;
  /** np. "HTTP 403 → headless fallback ok" */
  note?: string;
  /** wydarzenia odtworzone z cache (bez wywołania LLM) */
  cached?: number;
  /** wydarzenia odrzucone z braku daty startu (atrakcje stałe) — brak = żadnego nie odrzucono */
  droppedInvalid?: number;
  /** followupy sprawdzone mimo niezmienionej strony źródła */
  followupsRechecked?: number;
  /** ścieżki obiektów w prywatnym archiwum (raw/ + llm/); brak = archiwum wyłączone */
  archive?: string[];
}

export interface RunTotals extends LlmUsage {
  sources: number;
  ok: number;
  unchanged: number;
  errors: number;
  skippedFb: number;
  skippedDead: number;
  empty: number;
  events: number;
  followupsTried: number;
  geoHits: number;
  geoMisses: number;
  /** wydarzenia odrzucone z braku daty startu — model mimo promptu zwraca atrakcje stałe */
  droppedInvalid: number;
  /** ile numerów komórkowych / e-maili usunięto przed publikacją (pii.ts) */
  redactedPhones: number;
  redactedEmails: number;
}

export interface RunReport {
  stage: "daily" | "digest";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: RunTotals;
  sources: SourceRun[];
  /** zużycie Bright Data w tym przebiegu (brak = wyłączone) */
  brightdata?: BdUsage;
  /** koszt przebiegu w rozbiciu na kategorie — to samo, co trafiło do costs.json */
  costs?: CostEntry[];
}
