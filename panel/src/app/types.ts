/**
 * Mirrors ../../src/types.ts (pipeline types).
 * Keep in sync when the pipeline schema changes.
 */

export type FetchStrategy = 'plain' | 'headless' | 'pdf' | 'api' | 'fb' | 'fb_group' | 'fb_event' | 'rss';

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
  ms: number;
  err?: string;
  /** np. "HTTP 403 → headless fallback ok" */
  note?: string;
  /** wydarzenia odtworzone z cache (bez wywołania LLM) */
  cached?: number;
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
}

export interface RunReport {
  stage: 'daily' | 'digest';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: RunTotals;
  sources: SourceRun[];
}
