/**
 * Sonda jednego źródła na żądanie (POST /probe na lokalnym moście) — mirrors ../../../src/types/probe.ts.
 *
 * Te dane NIE pochodzą z repo: nigdy nie ma ich w runs.json ani events.json. Żyją tylko
 * w odpowiedzi mostu, czyli na maszynie osoby, która kliknęła — dlatego wydarzenia są tu
 * przed scalaniem duplikatów i przed redakcją PII.
 */

import type { EventItem, PipelineError, SourceRun } from './types';
import type { SourceTrail } from './types-audit';

export type LlmTask = 'extract' | 'poster' | 'discover' | 'verify';

export interface ProbeLlmCall {
  task: LlmTask;
  model: string;
  system: string;
  /** Prompt użytkownika; części obrazowe zastąpione opisem rozmiaru. */
  user: string;
  response: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  ms: number;
  ok: boolean;
  err?: string;
  /** adres obrazu, który poszedł do modelu — bajty zostają poza odpowiedzią, adres wystarczy */
  imageSrc?: string;
}

export interface ProbeResult {
  sourceId: string;
  startedAt: string;
  ms: number;
  /** Czy pominięto cache (świeże pobranie + wywołanie modelu). */
  forced: boolean;
  run: SourceRun;
  trail: SourceTrail;
  /** Przed dedupe i przed redakcją PII. */
  events: EventItem[];
  errors: PipelineError[];
  llm: ProbeLlmCall[];
}
