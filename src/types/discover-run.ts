/** Raport przebiegu discover (discover-runs.json). */

import type { ConfigSnapshot } from "../config/snapshot.js";
import type { Bounds } from "../shared/bbox.js";
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
  /**
   * Prostokąt, w którym discovery SZUKAŁO gmin: granice miasta centralnego + promień.
   * Zapisujemy go, bo to jedyny zapis ZASIĘGU PROJEKTU, jaki gdziekolwiek istnieje —
   * `center` + `radius_km` z sources.json opisują punkt i promień, a prawdziwy obszar
   * jest o całą rozciągłość miasta centralnego większy (Poznań to ~24 km w poprzek,
   * więc Mosina leży 20 km od środka i 5 km od granicy). Geokoder pyta o ten sam
   * prostokąt — patrz `setGeoRegion` w adapters/nominatim.ts.
   */
  bounds?: Bounds;
  err?: string;
  /** Overpass padł — discovery poleciało tylko dla miasta centralnego */
  fallback?: boolean;
  /**
   * Kod odpowiedzi Overpass przy błędzie. 4xx (poza 429) = odbity NASZ request — wada
   * konfiguracji, którą powtórzenie przebiegu utrwala zamiast naprawić; 5xx/429 = ich
   * przeciążenie. Bez tego pola oba wyglądają w raporcie identycznie.
   */
  httpStatus?: number;
  /**
   * Ile gmin OSM w ogóle rozważył (prostokąt), zanim przycięliśmy je do promienia.
   * Rozstrzyga „mało gmin, bo region jest rzadki" kontra „mało, bo filtr za ostry".
   */
  considered?: number;
  /**
   * Ile żądań poszło do Overpass (oba zapytania razem). Więcej niż 2 znaczy, że instancja
   * odbijała i ponawialiśmy — przebieg się udał, ale usługa jest niestabilna. Bez tej liczby
   * ponowienie jest niewidoczne i „czasem wychodzi sześć gmin, czasem jedna" nie ma wyjaśnienia.
   */
  attempts?: number;
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
  /**
   * `confirmed` to nie odmiana `duplicate`, tylko przeciwieństwo: adres już był w rejestrze,
   * ale WŁAŚNIE go potwierdziliśmy trafieniem z wyszukiwarki i dopisaliśmy proweniencję.
   * Wcześniej obie sytuacje wyglądały jak „duplikat, pomijamy" i 46 ręcznie wpisanych źródeł
   * nie miało szans nigdy dorobić się odpowiedzi na „skąd to się tu wzięło".
   */
  decision: "added" | "confirmed" | "duplicate" | "low-confidence" | "invalid";
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
  /** źródła już znane, potwierdzone trafieniem z wyszukiwarki w tym przebiegu */
  confirmed: number;
  /** co model zaproponował i co z tym zrobiliśmy (także odrzucenia) */
  proposals: SourceProposal[];
  /**
   * Czy dało się odczytać odpowiedź modelu. `no-json`/`bad-json` to awaria ekstrakcji,
   * nie „brak źródeł w gminie" — bez tego pola jedno wygląda dokładnie jak drugie.
   *
   * `truncated` wydzielone z `bad-json`, bo to inna awaria i inna naprawa: model NIE zwrócił
   * złego JSON-a, tylko został przerwany na limicie `max_tokens` w środku tablicy. Poznań
   * 2026-08-01 przepalił tak $0.093 i zameldował „niepoprawny JSON od modelu" — diagnozę,
   * która kierowała na prompt zamiast na limit.
   */
  parse?: "ok" | "no-json" | "bad-json" | "truncated" | "no-sources";
  /** ile kompletnych propozycji wyłuskano z uciętej odpowiedzi (reszta przepadła) */
  recovered?: number;
  /** powód zatrzymania modelu prosto od dostawcy: `length` = ucięte na limicie */
  finish?: string;
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
  /** źródła już w rejestrze, które discovery potwierdziło trafieniem z wyszukiwarki */
  sourcesConfirmed: number;
  /** źródła w objętych gminach, których discovery w tym przebiegu NIE znalazło */
  sourcesMissed: number;
  /** źródła zdegradowane w tym przebiegu (brak trafień + zero plonu) */
  sourcesDeactivated: number;
  /** wejścia usunięte z rejestru po kolejnych przebiegach bez ani jednego wydarzenia */
  entrypointsDropped: number;
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

/**
 * Źródło skasowane przez `--reset` wraz z tym, czy discovery znalazło je z powrotem.
 * To jest cały sens resetu: nie „wyczyść i zapomnij", tylko „wyczyść i pokaż, czego
 * wyszukiwarka NIE potrafi odtworzyć" — te adresy albo wracają same, albo są dowodem,
 * że trzymały się wyłącznie na ręcznym wpisie.
 */
export interface RemovedSource {
  id: string;
  name: string;
  url: string;
  town: string;
  type: SourceType;
  fetch: FetchStrategy;
  /** było oznaczone `dead:true` już przed resetem */
  dead?: boolean;
  /** id, pod którym adres wrócił do rejestru w tym samym przebiegu (null = nie wrócił) */
  returned?: string;
  /** adres, pod którym wrócił, gdy różni się od skasowanego */
  returnedUrl?: string;
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
  /** progi, którymi kierował się ten przebieg (patrz RunReport.config) */
  config?: ConfigSnapshot;
  /** szczegóły (wyniki search, propozycje) usunięte przy przycinaniu pliku */
  slimmed?: boolean;
  /** rejestr skasowany przed przebiegiem (`--reset`) — z rozliczeniem, co wróciło */
  reset?: { removed: RemovedSource[] };
}
