/** Scalanie tego samego wydarzenia z kilku źródeł. */
import { eventKey } from "../shared/event-key.js";
import type { EventItem } from "../types/index.js";
import { DEDUPE_SYSTEM } from "./prompts.js";

/** Rekord, który przegrał scalanie, i ten, który go zastąpił. */
export interface DedupeDrop {
  loser: EventItem;
  winner: EventItem;
}

export interface DedupeResult {
  events: EventItem[];
  /**
   * Przegrani — bez tego scalanie było jedyną decyzją potoku niezostawiającą śladu:
   * wydarzenie znikało z events.json i z panelu, a `source_id` cicho zmieniało się
   * na to źródło, które akurat zwróciło dłuższy JSON.
   */
  dropped: DedupeDrop[];
}

// normalizacja mieszka w shared/event-key.ts — raport plonu musi scalać identycznie
const keyOf = (ev: EventItem): string => eventKey(ev.title, ev.date_start);

/** Tania heurystyka; LLM-owy dedupe (DEDUPE_SYSTEM) do podpięcia dla niejednoznacznych par. */
export function dedupe(events: EventItem[]): DedupeResult {
  const seen = new Map<string, EventItem>();
  const out: EventItem[] = [];
  const losers: { loser: EventItem; key: string }[] = [];
  for (const ev of events) {
    const key = keyOf(ev);
    const prev = seen.get(key);
    if (prev) {
      if (JSON.stringify(ev).length > JSON.stringify(prev).length) {
        out[out.indexOf(prev)] = ev; // zachowaj bogatszy rekord
        seen.set(key, ev);
        losers.push({ loser: prev, key });
      } else {
        losers.push({ loser: ev, key });
      }
      continue;
    }
    seen.set(key, ev);
    out.push(ev);
  }
  // zwycięzcę rozwiązujemy dopiero teraz: w łańcuchu A→B→C w events.json ląduje C,
  // więc wskazywanie przegranemu A pośredniego B byłoby mylące
  // seen ma klucz każdego przegranego — trafił tam przy pierwszym wystąpieniu
  const dropped = losers.map(({ loser, key }) => ({ loser, winner: seen.get(key)! }));
  return { events: out, dropped };
}
void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO
