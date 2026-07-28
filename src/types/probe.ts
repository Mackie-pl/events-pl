/**
 * Sonda jednego źródła na żądanie — „sprawdź TO źródło TERAZ", z panelu albo z CLI.
 *
 * Wynik NIE JEST produktem: nie trafia do events.json, runs.json ani audit.json i nigdy
 * nie jest commitowany. Żyje wyłącznie w odpowiedzi HTTP lokalnego mostu, czyli na maszynie
 * osoby, która kliknęła. Dlatego — w odróżnieniu od wszystkiego, co idzie do publicznego
 * repo — wydarzenia są tu PRZED redakcją PII i PRZED scalaniem duplikatów: sonda ma
 * pokazać, co źródło naprawdę dało, a nie co przetrwało resztę potoku.
 */

import type { EventItem, PipelineError } from "./event.js";
import type { SourceTrail } from "./audit.js";
import type { SourceRun } from "./run.js";
import type { LlmTask } from "./usage.js";

/**
 * Jedno wywołanie modelu z sondy — prompt, odpowiedź i rachunek.
 *
 * W przebiegu crona to samo ląduje w prywatnym archiwum (`llm/…`), bo nikt nie patrzy
 * na ekran o 4 rano. Sonda odsyła to od razu: archiwum jest wtedy okrężną drogą do danych,
 * które i tak masz przed sobą.
 */
export interface ProbeLlmCall {
  task: LlmTask;
  model: string;
  system: string;
  /** Prompt użytkownika; części obrazowe (plakat w base64) zastąpione opisem rozmiaru. */
  user: string;
  response: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  ms: number;
  ok: boolean;
  err?: string;
}

export interface ProbeResult {
  sourceId: string;
  startedAt: string;
  ms: number;
  /**
   * Czy pominęliśmy cache. Bez tego sonda niezmienionej strony odpowiada w 200 ms
   * „5 wydarzeń z cache" i niczego nie sprawdza — a właśnie sprawdzenie było celem.
   */
  forced: boolean;
  /** Ten sam kształt, co wiersz w runs.json — panel renderuje to istniejącymi widokami. */
  run: SourceRun;
  /** Ślad decyzyjny tej sondy (nie miesza się ze śladem przebiegów crona). */
  trail: SourceTrail;
  /** Wydarzenia PRZED dedupe i PRZED redakcją PII — zostają na localhoście. */
  events: EventItem[];
  errors: PipelineError[];
  llm: ProbeLlmCall[];
}
