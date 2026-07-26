/** Wspólne atrapy dla testów. EventItem ma 15 pól wymaganych — bez fabryki każdy test to ściana szumu. */
import type { EventItem } from "../src/types/index.js";

export function event(over: Partial<EventItem> = {}): EventItem {
  return {
    title: "Wydarzenie",
    date_start: "2026-08-01",
    date_end: null,
    time_start: null,
    time_end: null,
    venue: null,
    town: null,
    price: { free: null, amount_pln: null, note: null },
    age: null,
    family_friendly: "maybe",
    tags: [],
    registration: null,
    sub_slots: null,
    conditional: null,
    source_url: "https://example.test/",
    is_noise: false,
    ...over,
  };
}
