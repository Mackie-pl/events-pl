/**
 * Raport plonu źródeł (`npm run source-yield`).
 *
 * Druga oś obok [ReuseReport]: tamten mierzy EFEKTYWNOŚĆ cache'a (ile z dzisiejszej treści
 * płacimy po raz drugi), ten mierzy PLON niezależnie od tego, czy źródło jest tanie.
 * Źródło potrafi mieć 100% odzysku i nadal być warte usunięcia, bo discovery wskazało
 * stronę, na której nic nie ma — a wtedy w reuse.json wygląda wzorowo.
 *
 * Liczone wyłącznie z runs.json, więc okno jest krótkie (retencja ~7 dni) i to jest cecha,
 * nie wada: reguły ekstrakcji zmieniają się z dnia na dzień, a dane sprzed tygodnia nie
 * mówią nic pewnego o dzisiejszym kodzie.
 */

export interface YieldSource {
  id: string;
  /** przebiegi, w których źródło było REALNIE pobierane (bez skipped-*) */
  runs: number;
  events: number;
  costUsd: number;
  /** koszt przebiegów, w których model poszedł i wrócił z zerem — czysta strata */
  zeroYieldCostUsd: number;
  zeroYieldRuns: number;
  emptyRuns: number;
  errorRuns: number;
}

export interface YieldReport {
  generated: string;
  /** okno wzięte z runs.json */
  from: string;
  to: string;
  totals: {
    sources: number;
    /** suma zapłacona za przebiegi z zerem wydarzeń */
    wastedUsd: number;
    /** źródła płatne i ZAWSZE puste mimo ≥2 pobrań — kandydaci do poprawy discovery */
    chronic: string[];
  };
  sources: YieldSource[];
}
