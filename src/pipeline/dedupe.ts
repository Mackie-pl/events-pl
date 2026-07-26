/** Scalanie tego samego wydarzenia z kilku źródeł. */
import type { EventItem } from "../types/index.js";
import { DEDUPE_SYSTEM } from "./prompts.js";

/** Tania heurystyka; LLM-owy dedupe (DEDUPE_SYSTEM) do podpięcia dla niejednoznacznych par. */
export function dedupe(events: EventItem[]): EventItem[] {
  const seen = new Map<string, EventItem>();
  const out: EventItem[] = [];
  for (const ev of events) {
    const key = `${(ev.title ?? "").toLowerCase().replace(/\W+/g, "").slice(0, 40)}|${ev.date_start}`;
    const prev = seen.get(key);
    if (prev) {
      if (JSON.stringify(ev).length > JSON.stringify(prev).length) {
        out[out.indexOf(prev)] = ev; // zachowaj bogatszy rekord
        seen.set(key, ev);
      }
      continue;
    }
    seen.set(key, ev);
    out.push(ev);
  }
  return out;
}
void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO
