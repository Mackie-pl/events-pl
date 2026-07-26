/** state.json — cache między przebiegami (hashe, geo, ekstrakcje). */

import type { EventItem } from "./event.js";

/**
 * Zapamiętany wynik ekstrakcji dla konkretnej treści.
 * Klucz w `extractions`: source.id (strona źródła) albo URL (followup: PDF/podstrona/plakat).
 *
 * Bez cache'owania samych wydarzeń „niezmienione" znaczyło „zero wydarzeń" — źródło znikało
 * z events.json do czasu, aż jego strona się zmieni. Hash oszczędza wywołanie LLM,
 * a `events` utrzymuje wynik przy życiu.
 *
 * Uwaga: state.json jest w publicznym repo, więc trzymane tu wydarzenia są PO redakcji PII.
 * Pełna wersja (z kontaktami) żyje w prywatnym archiwum z dnia ekstrakcji.
 */
export interface CachedExtraction {
  /** sha256 treści, z której powstały te wydarzenia */
  hash: string;
  events: EventItem[];
  at: string;
  /** walidatory HTTP — pozwalają pominąć pobranie w całości (304) */
  etag?: string;
  lastModified?: string;
}

export interface PipelineState {
  /** legacy: sam hash bez wyniku. Zastąpione przez `extractions`, zostaje dla starych plików. */
  hashes: Record<string, string>;
  /** cache geokodera per "venue|town" */
  geo: Record<string, { lat: number; lon: number } | null>;
  /** cache ekstrakcji per source.id / URL followupa */
  extractions?: Record<string, CachedExtraction>;
  /**
   * Followupy ostatnio widziane w danym źródle. Followupy pochodzą z ekstrakcji strony,
   * więc przy niezmienionej stronie nie znamy ich z bieżącego przebiegu — a plakat potrafi
   * się zmienić pod tym samym URL-em przy nietkniętym tekście strony.
   */
  followupsBySource?: Record<string, string[]>;
  /**
   * Linki facebook.com/events/… ostatnio wyłuskane z treści danego źródła — analogicznie
   * do followupsBySource: przy 304 nie mamy tekstu, a rozwiązane wydarzenia FB nie mogą
   * przez to znikać z serwisu.
   */
  fbUrlsBySource?: Record<string, string[]>;
}
