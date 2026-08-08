/** Raport przebiegu daily (runs.json). */

import type { CostEntry } from "./cost.js";
import type { FetchStrategy } from "./source.js";
import type { BdUsage, LlmUsage, TaskUsage } from "./usage.js";

// ---------------- observability / run reporting ----------------

/**
 * `skipped-dead` i `skipped-inactive` to dwie różne diagnozy i dlatego są dwoma statusami:
 * pierwszy znaczy „drabina udowodniła, że adresu nie ma", drugi „discovery przestało go
 * znajdować i nic z niego nie plonuje". Pierwszy naprawia re-discovery, drugi sam wraca,
 * gdy wyszukiwarka znowu pokaże adres.
 */
export type SourceStatus =
  | "ok" | "unchanged" | "error" | "skipped-fb" | "skipped-dead" | "skipped-inactive" | "empty";

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
  kind?: "html" | "pdf" | "feed";
  /**
   * Wyjście maszynowe użyte zamiast skrobania HTML-a. Obecne = to źródło nie kosztowało
   * ani jednego wywołania modelu; `llm.calls === 0` przy `events > 0` jest tego dowodem
   * w costs.json. `fellBack` = feed nic nie dał i wróciliśmy na stronę + model.
   */
  structured?: {
    kind: "rss" | "wp-rest" | "tribe" | "ical" | "jsonld";
    url: string;
    /** rekordów w feedzie (przed odsiewem) */
    seen: number;
    /** wydarzeń po odsiewie */
    items: number;
    /** ile i dlaczego odpadło — bez tego „8 rekordów → 3 wydarzenia" jest zagadką */
    dropped?: { past?: number; noDate?: number; noTitle?: number };
    fellBack?: boolean;
  };
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
  /**
   * Wydarzenia odsiane jako minione. Rośnie wraz z cache'em bloków: wpis oceniony „dziś"
   * sprzed tygodnia oddaje terminy, które w międzyczasie minęły. Zero nie znaczy „nie było
   * czego odsiewać" — znaczy „nic nie wygasło od ostatniego czytania".
   */
  droppedPast?: number;
  /**
   * Rozliczenie ścieżki blokowej: ile bloków miała strona, ile wróciło z cache, ile poszło
   * do modelu. Brak = źródło szło starą drogą (jedno wywołanie na całość) albo w ogóle
   * nie dotknęło modelu. `fresh: 0` przy `total > 0` to dzień w pełni darmowy.
   */
  blocks?: { total: number; cached: number; fresh: number };
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
  /** pominięte jako zdegradowane — brak trafień w discovery i zero plonu */
  skippedInactive: number;
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
