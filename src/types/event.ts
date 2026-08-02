/**
 * Wydarzenie i plik wynikowy events.json.
 *
 * Kształt tego, co zwraca MODEL, mieszka w event-schema.ts — tam jest jedno źródło prawdy
 * dla typu, promptu i `response_format`. Tutaj zostaje wyłącznie to, czego model nie
 * produkuje: pola dopisywane przez potok po ekstrakcji.
 */

import type { Followup, ModelEvent } from "./event-schema.js";
import type { BdUsage } from "./usage.js";

export type { AgeRange, Followup, Price, SubSlot } from "./event-schema.js";

export interface EventItem extends ModelEvent {
  /** dopisywane w process-source.ts / fb-events.ts — model o źródle nie wie */
  source_id?: string;
  /** dopisywane po geokodowaniu (Nominatim + cache) */
  geo?: { lat: number; lon: number } | null;
}

export interface ExtractionResult {
  events: EventItem[];
  followups?: Followup[];
  /**
   * Czy dało się odczytać odpowiedź modelu. Brak pola = odczytana w całości.
   *
   * Do 2026-08 parser połykał wyjątek i zwracał pustą listę, więc ucięta odpowiedź wyglądała
   * IDENTYCZNIE jak strona bez wydarzeń: `status: "empty"` i nic więcej. Trzy poznańskie
   * źródła stały tak przez pięć przebiegów, płacąc ~$0.49 dziennie za zero wydarzeń.
   */
  parse?: "no-json" | "bad-json" | "truncated";
  /** ile kompletnych wydarzeń wyłuskano z uciętej odpowiedzi */
  recovered?: number;
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
