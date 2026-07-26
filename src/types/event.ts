/** Wydarzenie i plik wynikowy events.json. */

import type { BdUsage } from "./usage.js";

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
