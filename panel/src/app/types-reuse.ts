/**
 * Mirrors ../../../src/types/reuse.ts.
 *
 * Osobny plik, nie types.ts: tamten siedzi na progu 350 linii, a te kształty i tak są
 * używane przez jedną stronę.
 *
 * `ReuseSamples` NIE przychodzi z repo — leży w prywatnym archiwum i panel dociąga go
 * przez most na localhoście. Wdrożony panel pokazuje same liczby i to jest zamierzone:
 * gdyby umiał pokazać treść stron, umiałby ją pokazać każdemu odwiedzającemu.
 */

export interface ReusePair {
  /** dzień PÓŹNIEJSZY z pary — ten, za który płacilibyśmy */
  day: string;
  prev: string;
  chars: number;
  blocks: number;
  newBlocks: number;
  newChars: number;
  /** udział znaków obecnych w poprzednim zrzucie — sufit dla dowolnej segmentacji */
  ceiling: number;
  reuse: number;
  /** brak = dzień spoza retencji runs.json */
  usd?: number;
}

export interface ReuseSource {
  id: string;
  followup: boolean;
  days: number;
  chars: number;
  ceiling: number;
  reuse: number;
  freeDays: number;
  freeUsd: number;
  shrinkUsd: number;
  pairs: ReusePair[];
  samples?: string;
}

export interface ReuseReport {
  generated: string;
  from: string;
  to: string;
  days: number;
  segment: { maxChars: number; targetParas: number };
  totals: {
    chars: number;
    pairs: number;
    ceiling: number;
    reuse: number;
    freeDays: number;
    freeUsd: number;
    shrinkUsd: number;
  };
  sources: ReuseSource[];
}

export interface ReuseSamples {
  id: string;
  generated: string;
  pairs: {
    day: string;
    prev: string;
    newBlocks: { hash: string; chars: number; text: string }[];
    omitted: number;
  }[];
}
