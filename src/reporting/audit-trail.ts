/**
 * Zapis śladu decyzyjnego: redakcja PII, retencja, składowisko.
 *
 * Osobny plik od runs.json, bo ma inny profil użycia: runs.json panel czyta przy KAŻDYM
 * wejściu (lista przebiegów, kafelki, koszty), a ślad tylko wtedy, gdy ktoś naprawdę
 * schodzi do jednego źródła. Wrzucony do runs.json podniósłby koszt każdego otwarcia
 * panelu o rząd wielkości, żeby obsłużyć widok otwierany raz na kilka dni.
 */
import type { RedactionStats } from "../pipeline/pii.js";
import { redactText } from "../pipeline/pii.js";
import { collection } from "../storage/index.js";
import type { CollectionStore, Retention } from "../storage/index.js";
import type { RunTrail, SourceTrail } from "../types/index.js";

/**
 * Notki i detale niosą tytuły wydarzeń, nazwy miejsc i fragmenty błędów — czyli treść
 * stron instytucji, w której siedzą numery do osób prowadzących zapisy. audit.json jest
 * w PUBLICZNYM repo, a git utrwala wszystko na zawsze, więc redagujemy PRZED zapisem.
 * URL-e zostają nietknięte: redactText sam je wycina z redakcji (numeryczne id w linkach).
 */
export function redactTrail(trails: SourceTrail[], stats?: RedactionStats): void {
  for (const trail of trails) {
    for (const step of trail.steps) {
      step.note = redactText(step.note, stats);
      for (const [k, v] of Object.entries(step.detail ?? {})) {
        if (typeof v === "string") step.detail![k] = redactText(v, stats);
      }
    }
  }
}

/**
 * Ta sama polityka, co dla runs.json — celowo co do liczby. Rozjazd oznaczałby przebieg
 * widoczny na liście, ale bez śladu (albo ślad bez przebiegu), a oba pliki są dopisywane
 * w tej samej transakcji, więc trzymają się razem tylko dopóki progi są identyczne.
 */
const TRAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const auditRetention: Retention<RunTrail> = {
  at: (t) => t.run,
  cutoff: () => new Date(Date.now() - TRAIL_RETENTION_MS).toISOString(),
  minKeep: 2,
  maxKeep: 30,
};

export const auditStore: CollectionStore<RunTrail> =
  collection<RunTrail>("audit", auditRetention);
