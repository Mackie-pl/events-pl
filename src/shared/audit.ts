/**
 * Zbieracz śladu decyzyjnego — „co potok zrobił i dlaczego", krok po kroku.
 *
 * Stan modułowy, dokładnie jak liczniki zużycia w adapters/openrouter.ts i ścieżki
 * archiwum w adapters/supabase-archive.ts, i z tego samego powodu: krok emituje funkcja
 * kilka poziomów w głąb, a przewleczenie kolektora przez wszystkie sygnatury zamieniłoby
 * dopisanie obserwowalności w przebudowę potoku.
 *
 * Dlaczego shared/, a nie reporting/: emitują TU wszystkie warstwy — adaptery, potok
 * i akcje. Gdyby kolektor mieszkał w reporting/, pipeline/ musiałby go zaimportować,
 * czyli odwrócić kierunek zależności ustalony w refaktorze warstw. Zapis, retencja
 * i redakcja są osobno, w reporting/audit-trail.ts.
 *
 * Ślad jest OBSERWOWALNOŚCIĄ, nie produktem: żadna funkcja tu nie rzuca i nie waliduje.
 * Najgorsze, co może się stać, to brakujący wiersz w panelu — nigdy wywrócony przebieg.
 */
import type { AuditDetail, AuditKind, SourceTrail } from "../types/index.js";

/** Kroki spoza pojedynczego źródła: scalanie duplikatów, redakcja, publikacja. */
export const RUN_SCOPE = "(run)";

/**
 * Sufit na źródło. Nie oszczędność, tylko bezpiecznik: krok na wydarzenie razy
 * rozpakowany program festiwalu potrafi zrobić z audit.json pliku na megabajty,
 * a to leci do publicznego repo przy KAŻDYM przebiegu crona.
 */
const MAX_STEPS_PER_SOURCE = 200;

let t0 = 0;
let current = RUN_SCOPE;
let trails = new Map<string, SourceTrail>();

/** Otwiera przebieg: zeruje ślad i ustawia punkt zerowy osi czasu. */
export function beginAuditRun(): void {
  t0 = performance.now();
  current = RUN_SCOPE;
  trails = new Map();
}

/** Przełącza kontekst na źródło — kolejne audit() trafią do jego śladu. */
export function beginAuditSource(id: string): void {
  current = id;
}

/** Krok w bieżącym źródle. */
export function audit(step: AuditKind, note: string, detail?: AuditDetail): void {
  auditFor(current, step, note, detail);
}

/**
 * Krok przypisany innemu źródłu niż bieżące. Potrzebne tam, gdzie decyzja zapada poza
 * pętlą źródeł, a dotyczy konkretnego: przegrany dedupe należy do źródła, które go dało.
 */
export function auditFor(id: string, step: AuditKind, note: string, detail?: AuditDetail): void {
  let trail = trails.get(id);
  if (!trail) {
    trail = { id, steps: [] };
    trails.set(id, trail);
  }
  if (trail.steps.length >= MAX_STEPS_PER_SOURCE) {
    trail.truncated = (trail.truncated ?? 0) + 1;
    return;
  }
  trail.steps.push({
    ms: Math.round(performance.now() - t0),
    step,
    note,
    ...(detail ? { detail } : {}),
  });
}

/** Ślady zebrane w tym przebiegu; źródła bez kroków się nie pojawiają. */
export const auditTrails = (): SourceTrail[] => [...trails.values()];
