/**
 * Mirrors ../../src/types.ts (pipeline types).
 * Keep in sync when the pipeline schema changes.
 */

export type FetchStrategy =
  'plain' | 'headless' | 'pdf' | 'api' | 'fb' | 'fb_group' | 'fb_event' | 'rss';

export type SourceType =
  | 'city_portal'
  | 'culture_center'
  | 'library'
  | 'sports'
  | 'venue'
  | 'fb_page'
  | 'fb_group'
  | 'rss'
  | 'api'
  | 'pdf_program';

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
  /** URL martwy — daily pomija (skipped-dead) do czasu naprawy */
  dead?: boolean;
  /** skąd się tu wzięło: zapytanie → wynik wyszukiwarki → decyzja modelu → pierwszy fetch */
  provenance?: SourceProvenance;
}

export interface SearchResult {
  title: string | null;
  url: string | null;
  desc: string | null;
}

/** Wynik jednego żądania HTTP — status, przekierowanie, typ i rozmiar odpowiedzi. */
export interface FetchProbe {
  at: string;
  url: string;
  ok: boolean;
  httpStatus?: number;
  finalUrl?: string;
  contentType?: string;
  chars?: number;
  ms: number;
  err?: string;
}

/** Pełna ścieżka trafienia źródła do rejestru (kopia żyje przy źródle w sources.json). */
export interface SourceProvenance {
  run: string;
  town: string;
  model: string;
  query?: string;
  hit?: SearchResult;
  confidence?: number;
  why?: string;
  firstFetch?: FetchProbe;
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
  date_start: string;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  venue: string | null;
  town: string | null;
  price: Price;
  age: AgeRange | null;
  family_friendly: boolean | 'maybe';
  tags: string[];
  registration: string | null;
  sub_slots: SubSlot[] | null;
  conditional: string | null;
  container?: string;
  source_url: string;
  source_id?: string;
  is_noise: boolean;
  geo?: { lat: number; lon: number } | null;
}

export interface PipelineError {
  id: string;
  err: string;
  followup?: string;
}

export interface EventsFile {
  generated: string;
  events: EventItem[];
  errors: PipelineError[];
}

// ---------------- observability / run reporting ----------------

export type SourceStatus = 'ok' | 'unchanged' | 'error' | 'skipped-fb' | 'skipped-dead' | 'empty';

export interface FollowupRun {
  url: string;
  kind: 'poster' | 'page';
  /** unchanged = treść identyczna (304 albo ten sam hash), wydarzenia odtworzone z cache */
  outcome: 'ok' | 'error' | 'unchanged';
  events: number;
  err?: string;
}

export interface LlmUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Rodzaj zadania LLM — rozdziela tekst od plakatów, których model nie odróżnia w rachunku. */
export type LlmTask = 'extract' | 'poster' | 'discover' | 'verify';

export type TaskUsage = Partial<Record<LlmTask, LlmUsage>>;

/** Zużycie Bright Data (rozliczenie per-rekord). */
export interface BdUsage {
  triggers: number;
  inputs: number;
  polls: number;
  records: number;
  errors: number;
  snapshots: string[];
  /** rekordy per dataset (fb_events / fb_group_posts) */
  byDataset?: Record<string, number>;
}

export interface SourceRun {
  id: string;
  name: string;
  town: string;
  url: string;
  fetch: FetchStrategy;
  status: SourceStatus;
  httpStatus?: number;
  kind?: 'html' | 'pdf';
  chars?: number;
  changed?: boolean;
  events: number;
  followups: FollowupRun[];
  geo: { hits: number; misses: number };
  llm: LlmUsage;
  /** ten sam koszt w rozbiciu na zadania; brak w przebiegach sprzed podziału */
  llmByTask?: TaskUsage;
  /** zużycie Bright Data przypisane temu źródłu (grupa FB / zbiorcze wydarzenia) */
  bd?: BdUsage;
  ms: number;
  err?: string;
  /** np. "HTTP 403 → headless fallback ok" */
  note?: string;
  /** wydarzenia odtworzone z cache (bez wywołania LLM) */
  cached?: number;
  /** wydarzenia odrzucone z braku daty startu (atrakcje stałe) */
  droppedNoDate?: number;
  /** ścieżki obiektów w prywatnym archiwum; treść dostępna tylko przez lokalny serwer */
  archive?: string[];
  /** followupy sprawdzone mimo niezmienionej strony źródła */
  followupsRechecked?: number;
}

export interface RunTotals extends LlmUsage {
  sources: number;
  ok: number;
  unchanged: number;
  errors: number;
  skippedFb: number;
  /** opcjonalne — starsze przebiegi w runs.json nie mają tego pola */
  skippedDead?: number;
  empty: number;
  events: number;
  followupsTried: number;
  geoHits: number;
  geoMisses: number;
  /** opcjonalne — starsze przebiegi w runs.json nie mają tych pól */
  redactedPhones?: number;
  redactedEmails?: number;
  /** wydarzenia odrzucone z braku daty startu (atrakcje stałe: zoo, place zabaw) */
  droppedNoDate?: number;
}

export interface RunReport {
  stage: 'daily' | 'digest';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: RunTotals;
  sources: SourceRun[];
  /** zużycie Bright Data w tym przebiegu (brak = wyłączone) */
  brightdata?: BdUsage;
  /** koszt przebiegu w rozbiciu na kategorie — kopia wpisów z costs.json */
  costs?: CostEntry[];
}

// ---------------- koszty ----------------

export type CostCategory =
  | 'llm-extract'
  | 'llm-vision'
  | 'llm-discover'
  | 'llm-verify'
  | 'fb'
  | 'search'
  | 'scrape'
  | 'geo'
  | 'storage';

export type CostUnit = 'calls' | 'records' | 'queries' | 'fetches' | 'lookups' | 'MB';

export interface CostDriver {
  id: string;
  usd: number;
  units: number;
}

export interface CostEntry {
  /** YYYY-MM-DD (UTC) */
  day: string;
  at: string;
  stage: 'daily' | 'discover' | 'digest';
  /** startedAt przebiegu — klucz do runs.json / discover-runs.json */
  run: string;
  category: CostCategory;
  usd: number;
  /** true = wolumen × stawka (nasz szacunek), false = kwota od dostawcy */
  estimated: boolean;
  units: number;
  unit: CostUnit;
  tokensIn?: number;
  tokensOut?: number;
  top?: CostDriver[];
  /** kategoria odtworzona ze starego raportu (backfill), nie zmierzona przy wywołaniu */
  inferred?: boolean;
}

export interface CostRates {
  bdPerRecord: number;
  bravePerQuery: number;
  storagePerGbMonth: number;
  scrapePerFetch: number;
  monthlyBudgetUsd: number;
}

export interface CostLedger {
  updated: string;
  rates: CostRates;
  retentionDays: number;
  entries: CostEntry[];
}

// ---------------- observability: discover (miesięczny) ----------------

export interface SearchCall {
  query: string;
  results: SearchResult[];
  ms: number;
  err?: string;
  httpStatus?: number;
  /** zapytanie niewysłane (wyczerpany budżet / wyłączona wyszukiwarka) */
  skipped?: boolean;
  /** wyniki usunięte przy przycinaniu starego przebiegu */
  trimmed?: number;
}

export interface GeoLookup {
  query: string;
  towns: string[];
  ms: number;
  err?: string;
  /** Overpass padł — discovery objęło tylko miasto centralne */
  fallback?: boolean;
}

export type ProposalDecision = 'added' | 'duplicate' | 'low-confidence' | 'invalid';

export interface SourceProposal {
  id: string;
  name: string;
  url: string;
  town: string;
  type?: SourceType;
  fetch?: FetchStrategy;
  confidence?: number;
  why?: string;
  decision: ProposalDecision;
  reason?: string;
  query?: string;
  hit?: SearchResult;
}

export interface TownDiscoveryRun {
  town: string;
  searches: SearchCall[];
  proposed: number;
  added: number;
  addedIds: string[];
  /** brak w przebiegach sprzed ledgeru propozycji */
  proposals?: SourceProposal[];
  parse?: 'ok' | 'no-json' | 'bad-json' | 'no-sources';
  responseChars?: number;
  llm: LlmUsage;
  ms: number;
  err?: string;
  archive?: string[];
}

export type VerificationOutcome = 'ok' | 'fixed' | 'dead' | 'error' | 'skipped';

export interface SourceVerification {
  id: string;
  name: string;
  town: string;
  url: string;
  outcome: VerificationOutcome;
  httpStatus?: number;
  err?: string;
  searches: SearchCall[];
  candidate?: string;
  newUrl?: string;
  llm: LlmUsage;
  ms: number;
  isNew?: boolean;
  probe?: FetchProbe;
  candidateProbe?: FetchProbe;
  note?: string;
  archive?: string[];
}

export interface DiscoverTotals extends LlmUsage {
  towns: number;
  searches: number;
  /** pola opcjonalne — starsze przebiegi ich nie mają */
  searchErrors?: number;
  searchesSkipped?: number;
  sourcesAdded: number;
  proposalsRejected?: number;
  sourcesChecked: number;
  ok: number;
  fixed: number;
  dead: number;
  unrepaired: number;
  skipped: number;
  costDiscoveryUsd: number;
  costVerifyUsd: number;
  redactedPhones?: number;
  redactedEmails?: number;
}

export interface DiscoverRunReport {
  stage: 'discover';
  mode: 'full' | 'verify';
  center?: string;
  radiusKm?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  geo?: GeoLookup;
  towns: TownDiscoveryRun[];
  verifications: SourceVerification[];
  totals: DiscoverTotals;
  argv?: string[];
  err?: string;
  partial?: boolean;
  archiveEnabled?: boolean;
  /** szczegóły (wyniki search, dopasowane trafienia) usunięte przy przycinaniu historii */
  slimmed?: boolean;
  /** koszt przebiegu w rozbiciu na kategorie — kopia wpisów z costs.json */
  costs?: CostEntry[];
}
