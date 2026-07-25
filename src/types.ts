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
}

// ---------------- observability: discover (miesięczny) ----------------

/** Jedno zapytanie do wyszukiwarki (Brave) wraz z tym, co zwróciła. */
export interface SearchCall {
  query: string;
  results: SearchResult[];
  ms: number;
  err?: string;
}

/** Zapytanie geo (Overpass): gminy w promieniu. */
export interface GeoLookup {
  query: string;
  towns: string[];
  ms: number;
  err?: string;
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
  llm: LlmUsage;
  ms: number;
  err?: string;
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
}

export interface DiscoverTotals extends LlmUsage {
  towns: number;
  /** liczba zapytań do Brave (limit darmowego tieru: 2000/mies.) */
  searches: number;
  sourcesAdded: number;
  sourcesChecked: number;
  ok: number;
  fixed: number;
  dead: number;
  unrepaired: number;
  skipped: number;
  /** koszt LLM per typ zadania */
  costDiscoveryUsd: number;
  costVerifyUsd: number;
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
}
