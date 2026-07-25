/** Wspólne typy pipeline'u. */

export type FetchStrategy =
  | "plain"
  | "headless"
  | "pdf"
  | "api"
  | "fb" // fanpage/strona FB — poza zakresem daily (osobny dataset)
  | "fb_group" // otwarta grupa FB — posty przez Bright Data → ekstrakcja LLM
  | "fb_event" // pojedyncze wydarzenie FB — rozwiązywane zbiorczo przez Bright Data (link → EventItem)
  | "rss";

export type SourceType =
  | "city_portal"
  | "culture_center"
  | "library"
  | "sports"
  | "venue"
  | "fb_page"
  | "fb_group"
  | "rss"
  | "api"
  | "pdf_program";

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  town: string;
  fetch: FetchStrategy;
  verified: boolean;
  notes?: string;
  discovered?: string;
  confidence?: number;
  /** data ostatniej weryfikacji URL (YYYY-MM-DD) — discover --verify */
  checked?: string;
  /** poprzednie, błędne adresy (historia napraw) */
  previous_urls?: string[];
  /** URL martwy i nienaprawialny — daily pomija (skipped-dead) do czasu naprawy */
  dead?: boolean;
  /** skąd się tu wzięło: zapytanie → wynik wyszukiwarki → decyzja modelu → pierwszy fetch */
  provenance?: SourceProvenance;
}

/**
 * Wynik jednego żądania HTTP — „co odpowiedział serwer, gdy pytaliśmy go pierwszy raz".
 * Sam kod statusu nie wystarcza do diagnozy: 200 z 300 bajtami to zwykle strona-zaślepka,
 * a 200 pod innym adresem niż pytany oznacza przekierowanie (np. na stronę główną).
 */
export interface FetchProbe {
  at: string;
  /** adres, o który pytaliśmy */
  url: string;
  ok: boolean;
  httpStatus?: number;
  /** adres po przekierowaniach — obecny tylko, gdy różny od `url` */
  finalUrl?: string;
  contentType?: string;
  /** długość odpowiedzi w znakach */
  chars?: number;
  ms: number;
  err?: string;
}

/**
 * Pełna ścieżka trafienia źródła do rejestru. Odpowiada na „dlaczego ten adres jest na liście?"
 * bez sięgania do przebiegów: kopia ląduje w sources.json obok samego źródła, więc przeżywa
 * przycinanie discover-runs.json.
 */
export interface SourceProvenance {
  /** startedAt przebiegu discover, który dodał źródło (klucz do discover-runs.json) */
  run: string;
  /** gmina, dla której leciało discovery */
  town: string;
  /** model, który zaproponował źródło */
  model: string;
  /** zapytanie, w którego wynikach znalazł się ten URL (dopasowanie po adresie) */
  query?: string;
  /** dopasowany wynik wyszukiwarki — dokładnie to, co model o tym adresie widział */
  hit?: SearchResult;
  confidence?: number;
  /** jednozdaniowe uzasadnienie modelu */
  why?: string;
  /** wynik pierwszego pobrania URL-a (weryfikacja tuż po dodaniu) */
  firstFetch?: FetchProbe;
  /** ścieżki w prywatnym archiwum: surowe wyniki search + prompt/odpowiedź modelu */
  archive?: string[];
}

export interface SourcesFile {
  region: {
    name: string;
    center: { lat: number; lon: number };
    radius_km: number;
    discovered_at: string;
    discovery_method: string;
  };
  comment?: string;
  sources: Source[];
  fb_note?: string;
  todo_next_discovery?: string[];
}

export interface AgeRange {
  min: number | null;
  max: number | null;
  /** oryginalny zapis, np. "4+", "roczniki 2015-2016", "dorośli" */
  label: string | null;
}

export interface Price {
  free: boolean | null;
  amount_pln: number | null;
  note: string | null;
}

export interface SubSlot {
  time: string;
  label: string;
  age?: AgeRange | null;
}

export interface EventItem {
  title: string;
  /** YYYY-MM-DD */
  date_start: string;
  date_end: string | null;
  /** HH:MM */
  time_start: string | null;
  time_end: string | null;
  venue: string | null;
  town: string | null;
  price: Price;
  age: AgeRange | null;
  family_friendly: boolean | "maybe";
  /** tagi zagnieżdżone, np. "dzieci:dmuchańce", "warsztaty:ceramika" */
  tags: string[];
  registration: string | null;
  sub_slots: SubSlot[] | null;
  /** np. "przy deszczu przeniesione na 26.07" */
  conditional: string | null;
  /** nazwa wydarzenia-kontenera, z którego rozpakowano */
  container?: string;
  source_url: string;
  source_id?: string;
  is_noise: boolean;
  geo?: { lat: number; lon: number } | null;
}

export interface Followup {
  url: string;
  reason: "program PDF" | "szczegóły wydarzenia" | "plakat" | (string & {});
}

export interface ExtractionResult {
  events: EventItem[];
  followups?: Followup[];
}

/**
 * Zapamiętany wynik ekstrakcji dla konkretnej treści.
 * Klucz w `extractions`: source.id (strona źródła) albo URL (followup: PDF/podstrona/plakat).
 *
 * Bez cache'owania samych wydarzeń „niezmienione" znaczyło „zero wydarzeń" — źródło znikało
 * z events.json do czasu, aż jego strona się zmieni. Hash oszczędza wywołanie LLM,
 * a `events` utrzymuje wynik przy życiu.
 *
 * Uwaga: state.json jest w publicznym repo, więc trzymane tu wydarzenia są PO redakcji PII.
 * Pełna wersja (z kontaktami) żyje w prywatnym archiwum z dnia ekstrakcji.
 */
export interface CachedExtraction {
  /** sha256 treści, z której powstały te wydarzenia */
  hash: string;
  events: EventItem[];
  at: string;
  /** walidatory HTTP — pozwalają pominąć pobranie w całości (304) */
  etag?: string;
  lastModified?: string;
}

export interface PipelineState {
  /** legacy: sam hash bez wyniku. Zastąpione przez `extractions`, zostaje dla starych plików. */
  hashes: Record<string, string>;
  /** cache geokodera per "venue|town" */
  geo: Record<string, { lat: number; lon: number } | null>;
  /** cache ekstrakcji per source.id / URL followupa */
  extractions?: Record<string, CachedExtraction>;
  /**
   * Followupy ostatnio widziane w danym źródle. Followupy pochodzą z ekstrakcji strony,
   * więc przy niezmienionej stronie nie znamy ich z bieżącego przebiegu — a plakat potrafi
   * się zmienić pod tym samym URL-em przy nietkniętym tekście strony.
   */
  followupsBySource?: Record<string, string[]>;
  /**
   * Linki facebook.com/events/… ostatnio wyłuskane z treści danego źródła — analogicznie
   * do followupsBySource: przy 304 nie mamy tekstu, a rozwiązane wydarzenia FB nie mogą
   * przez to znikać z serwisu.
   */
  fbUrlsBySource?: Record<string, string[]>;
}

/** Zużycie Bright Data w przebiegu — podstawa do policzenia kosztu (rozliczenie per-rekord). */
export interface BdUsage {
  /** liczba wywołań /trigger */
  triggers: number;
  /** liczba URL-i wysłanych do scrapowania */
  inputs: number;
  /** liczba wywołań /progress (polling) */
  polls: number;
  /** liczba zwróconych rekordów — główny czynnik kosztu */
  records: number;
  /** liczba nieudanych zbiorów */
  errors: number;
  /** snapshot_id każdego triggera — BD trzyma snapshoty ~30 dni, ponowny download jest darmowy */
  snapshots: string[];
  /**
   * Rekordy per dataset (`fb_events` / `fb_group_posts`). Rachunek przychodzi łączny,
   * a to dwa różne mechanizmy wzrostu: linków do wydarzeń przybywa wolno, natomiast
   * jedna gadatliwa grupa potrafi w jednym przebiegu dołożyć setki postów.
   */
  byDataset?: Record<string, number>;
}

export interface EventsFile {
  generated: string;
  events: EventItem[];
  errors: PipelineError[];
  brightdata?: BdUsage;
}

export interface PipelineError {
  id: string;
  err: string;
  followup?: string;
}

export interface SearchResult {
  title: string | null;
  url: string | null;
  desc: string | null;
}

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

/** Zużycie LLM (tokeny + koszt) — akumulowane w llm.ts. */
export interface LlmUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Rodzaj zadania LLM. Rozdziela to, co w rachunku wygląda identycznie („Haiku, $0.04"),
 * a psuje się z zupełnie różnych powodów: tekst strony rośnie razem z serwisem,
 * a plakaty (`poster`, wejście multimodalne) potrafią kosztować kilka razy tyle
 * co tekst przy tej samej liczbie wywołań.
 */
export type LlmTask = "extract" | "poster" | "discover" | "verify";

/** Zużycie LLM w rozbiciu na zadania; obecne tylko dla zadań, które faktycznie wystąpiły. */
export type TaskUsage = Partial<Record<LlmTask, LlmUsage>>;

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
  | "search" // Brave Search: zapytania (darmowy tier 2000/mies.)
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
  /** $ za zapytanie Brave ponad darmowy tier (2000/mies.) */
  bravePerQuery: number;
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

// ---------------- observability: discover (miesięczny) ----------------

/** Jedno zapytanie do wyszukiwarki (Brave) wraz z tym, co zwróciła. */
export interface SearchCall {
  query: string;
  results: SearchResult[];
  ms: number;
  err?: string;
  /** kod odpowiedzi Brave przy błędzie (429 = limit, 401 = klucz) */
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
 * Weryfikacja URL jednego źródła.
 * ok: URL działa · fixed: naprawiony (stary w previous_urls) · dead: naprawa się nie udała,
 * źródło oznaczone dead:true · error: URL padł, ale naprawy nie próbowano (np. brak BRAVE_API_KEY)
 * — źródło nietknięte · skipped: nie weryfikujemy (fb).
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
  /** liczba zapytań do Brave (limit darmowego tieru: 2000/mies.) */
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
