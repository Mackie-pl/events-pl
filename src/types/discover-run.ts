/** Raport przebiegu discover (discover-runs.json). */

import type { CostEntry } from "./cost.js";
import type {
  EntryPoint, FetchProbe, FetchStrategy, ReachOutcome, SearchResult, SourceCapability, SourceType,
} from "./source.js";
import type { LlmUsage } from "./usage.js";

// ---------------- observability: discover (miesięczny) ----------------

/**
 * Wynik JEDNEGO zapytania od dostawcy wyszukiwarki — kontrakt, który spełniają `serper.ts`,
 * `google-cse.ts` i `brave.ts`.
 *
 * `fatal` niesie rozstrzygnięcie, którego nie da się odtworzyć wyżej: czy błąd jest trwały
 * dla całego przebiegu (zły klucz, wyczerpane kredyty), czy to pojedyncze potknięcie.
 * Dostawcy różnią się tu radykalnie — Google mówi to w `error.errors[].reason`, Serper
 * w polu `message`, Brave samym kodem HTTP — i tylko oni wiedzą, jak to przeczytać.
 */
export interface SearchProviderOutcome {
  results: SearchResult[];
  /** niepusty = wyłącz wyszukiwarkę do końca przebiegu */
  fatal?: string;
}

/** Jedno zapytanie do wyszukiwarki wraz z tym, co zwróciła. */
export interface SearchCall {
  query: string;
  results: SearchResult[];
  ms: number;
  err?: string;
  /** kod odpowiedzi wyszukiwarki przy błędzie (429 = limit, 401/403 = klucz) */
  httpStatus?: number;
  /** zapytanie niewysłane (wyczerpany budżet albo wyłączona wyszukiwarka) */
  skipped?: boolean;
  /** ile wyników usunięto przy przycinaniu starego przebiegu (patrz DiscoverRunReport.slimmed) */
  trimmed?: number;
}

/** Zapytanie geo (Overpass): gminy w promieniu. */
export interface GeoLookup {
  query: string;
  towns: string[];
  ms: number;
  err?: string;
  /** Overpass padł — discovery poleciało tylko dla miasta centralnego */
  fallback?: boolean;
}

/**
 * Jedna propozycja modelu wraz z tym, co się z nią stało. Odrzucone zostają w raporcie
 * celowo: „model tego nie zaproponował" i „zaproponował, ale odrzuciliśmy przy progu
 * confidence" to zupełnie różne diagnozy, a bez ledgeru są nie do odróżnienia.
 */
export interface SourceProposal {
  id: string;
  name: string;
  url: string;
  town: string;
  type?: SourceType;
  fetch?: FetchStrategy;
  confidence?: number;
  /** jednozdaniowe uzasadnienie modelu */
  why?: string;
  decision: "added" | "duplicate" | "low-confidence" | "invalid";
  /** powód odrzucenia albo opis normalizacji (np. "id zajęte → gok-lubon-2") */
  reason?: string;
  /** zapytanie, w którego wynikach był ten URL */
  query?: string;
  /** dopasowany wynik wyszukiwarki */
  hit?: SearchResult;
}

/** Discovery jednego miasta/gminy: wyszukiwania -> LLM -> nowe źródła. */
export interface TownDiscoveryRun {
  town: string;
  searches: SearchCall[];
  /** źródła zaproponowane przez LLM */
  proposed: number;
  /** faktycznie dodane po merge (nowe URL-e, confidence >= 0.5) */
  added: number;
  addedIds: string[];
  /** co model zaproponował i co z tym zrobiliśmy (także odrzucenia) */
  proposals: SourceProposal[];
  /**
   * Czy dało się odczytać odpowiedź modelu. `no-json`/`bad-json` to awaria ekstrakcji,
   * nie „brak źródeł w gminie" — bez tego pola jedno wygląda dokładnie jak drugie.
   */
  parse?: "ok" | "no-json" | "bad-json" | "no-sources";
  /** długość odpowiedzi modelu w znakach */
  responseChars?: number;
  llm: LlmUsage;
  ms: number;
  err?: string;
  /** ścieżki w prywatnym archiwum (wyniki search + prompt/odpowiedź modelu) */
  archive?: string[];
}

/**
 * Weryfikacja i sprofilowanie jednego źródła.
 * ok: URL działa · fixed: naprawiony (stary w previous_urls; także zmianą schematu/www albo
 * przejściem na headless) · dead: adres nie do uratowania, źródło oznaczone dead:true ·
 * error: padło, ale nie wiemy czy trwale — źródło nietknięte · skipped: nie weryfikujemy (fb).
 *
 * Uwaga na różnicę wobec wersji sprzed profilera: `dead` NIE wymaga już udziału wyszukiwarki.
 * Domena, która nie rozwiązuje się w DNS, jest martwa niezależnie od tego, czy mamy klucz —
 * wcześniej brak klucza kończył się `error` i daily dobijało się do niej codziennie.
 */
export interface SourceVerification {
  id: string;
  name: string;
  town: string;
  url: string;
  outcome: "ok" | "fixed" | "dead" | "error" | "skipped";
  httpStatus?: number;
  err?: string;
  searches: SearchCall[];
  /** werdykt drabiny osiągalności — mówi, KTÓRA naprawa ma sens */
  reach?: ReachOutcome;
  /** kolejne szczeble drabiny (adres → wynik), gdy pierwszy adres nie zadziałał */
  ladder?: Array<{ url: string; outcome: ReachOutcome; httpStatus?: number; err?: string }>;
  /** rozpoznane adresy list wydarzeń */
  entrypoints?: EntryPoint[];
  /** maszynowe wyjścia potwierdzone pobraniem */
  capabilities?: SourceCapability[];
  /** werdykt modelu o entrypoincie: czy to w ogóle strona z wydarzeniami */
  verdict?: "events" | "news" | "none";
  /** URL zaproponowany przez LLM przy naprawie */
  candidate?: string;
  /** nowy URL po udanej naprawie */
  newUrl?: string;
  llm: LlmUsage;
  ms: number;
  /** źródło dodane w TYM przebiegu — `probe` jest wtedy jego pierwszym w życiu fetchem */
  isNew?: boolean;
  /** pełny wynik żądania (status, przekierowanie, content-type, rozmiar) */
  probe?: FetchProbe;
  /** wynik sprawdzenia URL-a zaproponowanego przy naprawie */
  candidateProbe?: FetchProbe;
  /** powód pominięcia (outcome: "skipped") */
  note?: string;
  /** ścieżki w prywatnym archiwum (prompt/odpowiedź modelu przy naprawie) */
  archive?: string[];
}

export interface DiscoverTotals extends LlmUsage {
  towns: number;
  /** liczba zapytań do wyszukiwarki (Google CSE: 100/dzień gratis, dalej $5/1000) */
  searches: number;
  /** zapytania zakończone błędem (429/401/timeout) — puste wyniki, nie „brak trafień" */
  searchErrors: number;
  /** zapytania niewysłane po wyczerpaniu budżetu DISCOVER_MAX_SEARCHES */
  searchesSkipped: number;
  sourcesAdded: number;
  /** propozycje modelu odrzucone (duplikat / niska pewność / niepoprawny rekord) */
  proposalsRejected: number;
  sourcesChecked: number;
  ok: number;
  fixed: number;
  dead: number;
  unrepaired: number;
  skipped: number;
  /** koszt LLM per typ zadania */
  costDiscoveryUsd: number;
  costVerifyUsd: number;
  /** ile numerów komórkowych / e-maili usunięto przed zapisem do publicznego repo */
  redactedPhones: number;
  redactedEmails: number;
}

export interface DiscoverRunReport {
  stage: "discover";
  mode: "full" | "verify";
  center?: string;
  radiusKm?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  geo?: GeoLookup;
  towns: TownDiscoveryRun[];
  verifications: SourceVerification[];
  totals: DiscoverTotals;
  /** argumenty wywołania — bez nich nie wiadomo, czy pusty przebieg to tryb, czy awaria */
  argv?: string[];
  /** błąd, który przerwał przebieg; raport i tak jest zapisany (patrz persistRun) */
  err?: string;
  /** true = przebieg nie dobiegł końca, liczby są cząstkowe */
  partial?: boolean;
  /** false = prywatne archiwum wyłączone, więc promptów modelu nie da się odtworzyć */
  archiveEnabled?: boolean;
  /** koszt przebiegu w rozbiciu na kategorie — to samo, co trafiło do costs.json */
  costs?: CostEntry[];
  /** szczegóły (wyniki search, propozycje) usunięte przy przycinaniu pliku */
  slimmed?: boolean;
}
