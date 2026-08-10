/**
 * Mirrors ../../../src/types/yield.ts.
 *
 * Osobny plik z tego samego powodu, co types-reuse.ts: types.ts siedzi na progu długości,
 * a te kształty używa jedna strona.
 *
 * Odwrotna oś niż `ReuseReport`: tamten mówi, ile z treści płacimy DRUGI RAZ, ten — ile
 * płacimy za treść, z której i tak nic nie wychodzi. Źródło z odzyskiem 100% potrafi
 * stać w tej tabeli na samej górze.
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
  from: string;
  to: string;
  totals: {
    sources: number;
    wastedUsd: number;
    /** płatne i ZAWSZE puste mimo ≥2 pobrań — kandydaci do poprawy discovery */
    chronic: string[];
  };
  sources: YieldSource[];
}
