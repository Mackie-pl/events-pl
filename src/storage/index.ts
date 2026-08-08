/**
 * WIĄZANIA SKŁADOWISKA — jedyne miejsce, które wie, gdzie naprawdę leżą dane.
 *
 * Reszta repo adresuje dane NAZWĄ LOGICZNĄ ("runs", "costs", …), nigdy ścieżką.
 * Dzięki temu przejście na bazę to podmiana `doc`/`collection` na implementację
 * bazodanową i tabela nazw poniżej — bez ruszania potoku i raportów. Jeśli
 * kiedykolwiek pojawi się `readFile(RUNS_PATH)` poza tym katalogiem, to jest
 * dokładnie ten wyciek abstrakcji, którego tu unikamy.
 *
 * Polityki retencji NIE mieszkają tutaj — należą do dziedziny (reporting/), bo to
 * decyzja produktowa, a nie składowania. Tutaj jest tylko mechanizm ich wykonania.
 */
import {
  AUDIT_PATH, COSTS_PATH, DISCOVER_RUNS_PATH, EVENTS_PATH, REUSE_PATH, RUNS_PATH, SOURCES_PATH,
  STATE_PATH,
} from "../shared/paths.js";
import type { EventsFile, PipelineState, SourcesFile } from "../types/index.js";

import { jsonCollection, jsonDoc } from "./json-file.js";
import type { CollectionStore, DocStore, Envelope, Retention } from "./types.js";

export type { CollectionStore, DocStore, Envelope, Retention } from "./types.js";
export { applyRetention } from "./json-file.js";

/** Nazwy logiczne zbiorów danych. W bazie: nazwy tabel. */
export type StoreName =
  "sources" | "events" | "state" | "runs" | "audit" | "discover-runs" | "costs" | "reuse";

const PATHS: Record<StoreName, string> = {
  sources: SOURCES_PATH,
  events: EVENTS_PATH,
  state: STATE_PATH,
  runs: RUNS_PATH,
  audit: AUDIT_PATH,
  "discover-runs": DISCOVER_RUNS_PATH,
  costs: COSTS_PATH,
  reuse: REUSE_PATH,
};

/** Fabryka dokumentu. Podmiana backendu = podmiana tej funkcji. */
export const doc = <T>(name: StoreName, fallback: () => T, opts?: { pretty?: boolean }): DocStore<T> =>
  jsonDoc<T>(PATHS[name], fallback, opts ?? {});

/** Fabryka kolekcji. Podmiana backendu = podmiana tej funkcji. */
export const collection = <T>(
  name: StoreName,
  retention: Retention<T>,
  envelope?: Envelope<T>,
): CollectionStore<T> => jsonCollection<T>(PATHS[name], retention, envelope);

// ---------------- dokumenty (bez polityki, więc mogą stać tutaj) ----------------

/**
 * Rejestr źródeł. Brak pliku to awaria, a nie „pusty rejestr": bez źródeł potok
 * nie ma czego pobierać, a cichy start od zera skasowałby cały dorobek discovery.
 */
export const sourcesStore: DocStore<SourcesFile> = doc<SourcesFile>(
  "sources",
  () => { throw new Error("Brak rejestru źródeł — uruchom najpierw: npm run discover"); },
);

export const eventsStore: DocStore<EventsFile> = doc<EventsFile>(
  "events",
  () => ({ generated: "", events: [], errors: [] }),
);

/** Bez wcięć: to czysty cache maszynowy, którego diff i tak jest nie do czytania. */
export const stateStore: DocStore<PipelineState> = doc<PipelineState>(
  "state",
  () => ({ hashes: {}, geo: {} }),
  { pretty: false },
);
