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
