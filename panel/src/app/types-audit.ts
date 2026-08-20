/**
 * Ślad decyzyjny (audit.json) — mirrors ../../../src/types/audit.ts.
 *
 * Osobny plik od types.ts, bo tamten dobił do progu 350 linii. Reeksport z types.ts
 * zostaje, żeby reszta panelu dalej importowała wszystko z jednego miejsca.
 */

/** Zamknięty słownik kroków — panel dobiera do rodzaju ikonę i kolor. */
export type AuditKind =
  | 'skip'
  | 'fetch'
  | 'fetch.fallback'
  | 'content'
  | 'cache.hit'
  | 'capability'
  | 'capability.parsed'
  | 'capability.fallback'
  | 'llm'
  | 'event.dropped'
  | 'block'
  /** ile świeżych bloków odsiało sito chromu i z jakiego powodu (patrz extract/chrome.ts) */
  | 'block.chrome'
  /** bloki → wydarzenia: co dały świeże, co cache (detail.archive = rozliczenie blok po bloku) */
  | 'block.parsed'
  | 'event.past'
  /** adres odrzucony PRZED pobraniem, bo stoi pod nim repertuar, a nie wydarzenia */
  | 'url.skipped'
  /** kolejka followupów: co model wskazał, co odsiał limit i co przestawił deficyt danych */
  | 'followup.proposed'
  /** adres followupa skonfrontowany z inwentarzem strony: przyciągnięty albo odrzucony */
  | 'followup.url'
  /** wpis o kształcie strony programu: sonda adresu i werdykt, czy stał pod nim program */
  | 'container'
  | 'followup'
  | 'fb.harvest'
  /** rytm publikacji grupy FB i werdykt dostępności (płatne rekordy vs. faktyczne posty) */
  | 'fb.group'
  /** próg opłacalności kanału FB: koszt za wydarzenie, którego nie dała żadna strona */
  | 'fb.value'
  /** regulator budżetu kanału FB: kolejka wartości, linia cięcia i cena źródła brzegowego */
  | 'fb.budget'
  | 'geo'
  | 'geo.not-found'
  | 'dedupe.dropped'
  | 'series'
  | 'pii'
  | 'done';

/**
 * Klucze o ustalonym znaczeniu, bo panel je formatuje albo linkuje, a nie tylko wypisuje:
 *   usd / tokIn / tokOut — rachunek za wywołanie modelu (patrz callDetail() w openrouter.ts),
 *   archive — ścieżka promptu i odpowiedzi w prywatnym archiwum, do odczytu przez most.
 */
export type AuditDetail = Record<string, string | number | boolean | null | undefined>;

export interface AuditStep {
  /** ms od startu przebiegu */
  ms: number;
  step: AuditKind;
  note: string;
  detail?: AuditDetail;
}

export interface SourceTrail {
  /** id źródła albo '(run)' dla kroków całego przebiegu */
  id: string;
  steps: AuditStep[];
  /** ile kroków ucięto po przekroczeniu limitu */
  truncated?: number;
}

export interface RunTrail {
  /** startedAt przebiegu — klucz wspólny z runs.json */
  run: string;
  day: string;
  sources: SourceTrail[];
}

/** Kroki spoza pojedynczego źródła: scalanie, redakcja, publikacja. */
export const RUN_SCOPE = '(run)';
