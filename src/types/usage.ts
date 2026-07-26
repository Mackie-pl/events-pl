/** Liczniki zużycia dostawców: LLM (per zadanie) i Bright Data. */

/** Zużycie Bright Data w przebiegu — podstawa do policzenia kosztu (rozliczenie per-rekord). */
export interface BdUsage {
  /** liczba wywołań /trigger */
  triggers: number;
  /** liczba URL-i wysłanych do scrapowania */
  inputs: number;
  /** liczba wywołań /progress (polling) */
  polls: number;
  /** liczba zwróconych rekordów — główny czynnik kosztu */
  records: number;
  /** liczba nieudanych zbiorów */
  errors: number;
  /** snapshot_id każdego triggera — BD trzyma snapshoty ~30 dni, ponowny download jest darmowy */
  snapshots: string[];
  /**
   * Rekordy per dataset (`fb_events` / `fb_group_posts`). Rachunek przychodzi łączny,
   * a to dwa różne mechanizmy wzrostu: linków do wydarzeń przybywa wolno, natomiast
   * jedna gadatliwa grupa potrafi w jednym przebiegu dołożyć setki postów.
   */
  byDataset?: Record<string, number>;
}

/** Zużycie LLM (tokeny + koszt) — akumulowane w llm.ts. */
export interface LlmUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Rodzaj zadania LLM. Rozdziela to, co w rachunku wygląda identycznie („Haiku, $0.04"),
 * a psuje się z zupełnie różnych powodów: tekst strony rośnie razem z serwisem,
 * a plakaty (`poster`, wejście multimodalne) potrafią kosztować kilka razy tyle
 * co tekst przy tej samej liczbie wywołań.
 */
export type LlmTask = "extract" | "poster" | "discover" | "verify";

/** Zużycie LLM w rozbiciu na zadania; obecne tylko dla zadań, które faktycznie wystąpiły. */
export type TaskUsage = Partial<Record<LlmTask, LlmUsage>>;
