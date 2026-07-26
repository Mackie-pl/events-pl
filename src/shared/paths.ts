/**
 * Jedyne miejsce, które wie, gdzie leżą pliki danych.
 *
 * Wcześniej pięć modułów liczyło własny ROOT z import.meta.url — a każdy z tych plików
 * jest wejściem do potoku nadpisującym dane produkcyjne, więc rozjazd o jeden katalog
 * oznaczałby zapis obok repo albo nadpisanie nie tego pliku.
 *
 * UWAGA przy przenoszeniu tego pliku: ROOT liczy się względem JEGO położenia. Siedzi
 * w src/shared/, czyli dwa poziomy pod korzeniem repo — stąd dwa "..".
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Rejestr źródeł (etap 1 zapisuje, etap 2 czyta). */
export const SOURCES_PATH = join(ROOT, "sources.json");
/** Wynik potoku — publikowany. */
export const EVENTS_PATH = join(ROOT, "events.json");
/** Cache między przebiegami: hashe, geo, ekstrakcje. Publiczny, więc po redakcji PII. */
export const STATE_PATH = join(ROOT, "state.json");
/** Raporty przebiegów daily (7 dni). */
export const RUNS_PATH = join(ROOT, "runs.json");
/** Raporty przebiegów discover (24 sztuki). */
export const DISCOVER_RUNS_PATH = join(ROOT, "discover-runs.json");
/** Księga kosztów (90 dni) — łączy etap 1 i 2, bo rachunek przychodzi jeden. */
export const COSTS_PATH = join(ROOT, "costs.json");
/** Log zużycia Bright Data per przebieg (rozliczenie per-rekord). */
export const BD_USAGE_LOG = join(ROOT, "brightdata-usage.jsonl");

/** Szablon strony i wyrenderowany serwis. */
export const TEMPLATE_HTML = join(ROOT, "template.html");
export const INDEX_HTML = join(ROOT, "index.html");
