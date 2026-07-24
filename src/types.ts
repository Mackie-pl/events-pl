/** Wspólne typy pipeline'u. */

export type FetchStrategy = "plain" | "headless" | "pdf" | "api" | "fb" | "rss";

export type SourceType =
  | "city_portal"
  | "culture_center"
  | "library"
  | "sports"
  | "venue"
  | "fb_page"
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

export interface PipelineState {
  /** sha256 treści per source.id — diff, żeby nie płacić za niezmienione strony */
  hashes: Record<string, string>;
  /** cache geokodera per "venue|town" */
  geo: Record<string, { lat: number; lon: number } | null>;
}

export interface EventsFile {
  generated: string;
  events: EventItem[];
  errors: PipelineError[];
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
  outcome: "ok" | "error";
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
