/**
 * Mirrors ../../src/types.ts (pipeline types).
 * Keep in sync when the pipeline schema changes.
 */

export type FetchStrategy = 'plain' | 'headless' | 'pdf' | 'api' | 'fb' | 'rss';

export type SourceType =
  | 'city_portal'
  | 'culture_center'
  | 'library'
  | 'sports'
  | 'venue'
  | 'fb_page'
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

export type SourceStatus = 'ok' | 'unchanged' | 'error' | 'skipped-fb' | 'empty';

export interface FollowupRun {
  url: string;
  kind: 'poster' | 'page';
  outcome: 'ok' | 'error';
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
}

export interface RunTotals extends LlmUsage {
  sources: number;
  ok: number;
  unchanged: number;
  errors: number;
  skippedFb: number;
  empty: number;
  events: number;
  followupsTried: number;
  geoHits: number;
  geoMisses: number;
}

export interface RunReport {
  stage: 'daily' | 'digest';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: RunTotals;
  sources: SourceRun[];
}
