/**
 * Cienki klient OpenRouter (OpenAI-compatible chat completions).
 * Modele wybierane przez env — łatwa ewaluacja różnych modeli bez zmian w kodzie:
 *   OPENROUTER_API_KEY  (wymagany)
 *   MODEL_EXTRACT       default: anthropic/claude-haiku-4.5   (tani, codzienna ekstrakcja)
 *   MODEL_DISCOVER      default: anthropic/claude-sonnet-4.6  (mocny, miesięczne discovery)
 */

import { fetchUrl } from "./http.js";
import { describeError } from "../shared/errors.js";
import type { LlmTask, LlmUsage, TaskUsage } from "../types/index.js";

// nadpisywalne: pozwala wpiąć proxy/gateway albo mock w testach integracyjnych
const OPENROUTER_URL =
  process.env["OPENROUTER_URL"] ?? "https://openrouter.ai/api/v1/chat/completions";

export const MODEL_EXTRACT = process.env["MODEL_EXTRACT"] ?? "anthropic/claude-haiku-4.5";
export const MODEL_DISCOVER = process.env["MODEL_DISCOVER"] ?? "anthropic/claude-sonnet-4.6";

/**
 * Akumulator zużycia LLM. Wywołania chat() są sekwencyjne (await) — bez współbieżności,
 * więc prosty licznik modułowy wystarcza. daily.ts robi resetUsage() przed każdym źródłem
 * i snapshotUsage() po, żeby przypisać tokeny/koszt do konkretnego źródła.
 */
const tally: LlmUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
/**
 * Ten sam licznik z podziałem na rodzaj zadania. Rachunek OpenRoutera zna tylko model,
 * a „Haiku" to zarówno tekst strony, jak i plakat (wejście multimodalne) — dwie pozycje
 * o różnych stawkach za wejście i o zupełnie różnych przyczynach wzrostu.
 */
const byTask = new Map<LlmTask, LlmUsage>();

export function resetUsage(): void {
  tally.calls = 0;
  tally.promptTokens = 0;
  tally.completionTokens = 0;
  tally.costUsd = 0;
  byTask.clear();
}

export function snapshotUsage(): LlmUsage {
  return { ...tally };
}

/** Zużycie w rozbiciu na zadania — tylko te, które w tym oknie wystąpiły. */
export function snapshotTasks(): TaskUsage {
  const out: TaskUsage = {};
  for (const [task, usage] of byTask) out[task] = { ...usage };
  return out;
}

function addTask(task: LlmTask, usage: { promptTokens: number; completionTokens: number; costUsd: number }): void {
  const cur = byTask.get(task) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  cur.calls += 1;
  cur.promptTokens += usage.promptTokens;
  cur.completionTokens += usage.completionTokens;
  cur.costUsd += usage.costUsd;
  byTask.set(task, cur);
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
export type UserContent = string | Array<TextPart | ImagePart>;

export interface ChatOptions {
  model: string;
  /** rodzaj zadania — nośnik podziału kosztów (costs.json), nie da się go odtworzyć z modelu */
  task: LlmTask;
  system: string;
  user: UserContent;
  maxTokens?: number;
  temperature?: number;
}

/** Pełne wejście/wyjście jednego wywołania — do prywatnego archiwum (archive.ts). */
export interface LlmCallRecord {
  model: string;
  task: LlmTask;
  system: string;
  user: UserContent;
  response: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  ms: number;
  ok: boolean;
  err?: string;
}

/**
 * Hook obserwacyjny. llm.ts nie wie nic o archiwum (brak zależności cyklicznej) —
 * daily.ts podpina recorder tylko wtedy, gdy archiwum jest skonfigurowane.
 * Recordery są wywoływane best-effort: ich błąd nie może wywrócić wywołania LLM.
 */
export type CallRecorder = (rec: LlmCallRecord) => void | Promise<void>;

let recorder: CallRecorder | null = null;

export function setCallRecorder(fn: CallRecorder | null): void {
  recorder = fn;
}

async function record(rec: LlmCallRecord): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(rec);
  } catch (e) {
    console.warn(`recorder LLM: ${String(e)}`);
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

const NO_USAGE = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

export async function chat(opts: ChatOptions): Promise<string> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("Brak OPENROUTER_API_KEY");

  const t0 = performance.now();
  const base = { model: opts.model, task: opts.task, system: opts.system, user: opts.user };
  const ms = (): number => Math.round(performance.now() - t0);
  // nieudane wywołania archiwizujemy tak samo jak udane — to one wymagają debugowania
  const failed = async (err: string): Promise<void> =>
    record({ ...base, response: "", usage: NO_USAGE, ms: ms(), ok: false, err });

  let res: Response;
  try {
    res = await fetchUrl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // rankingi/atrybucja OpenRouter (opcjonalne, ale mile widziane):
      "HTTP-Referer": "https://github.com/Mackie-pl/events-pl",
      "X-Title": "events-pl",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature ?? 0.2,
      // zwróć koszt (USD) i tokeny w polu usage
      usage: { include: true },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
    }, 120_000, `OpenRouter ${opts.model}`);
  } catch (e) {
    await failed(describeError(e));
    throw e;
  }

  const raw = await res.text();
  let json: ChatCompletionResponse;
  try {
    json = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    // np. strona błędu 502 od proxy zamiast JSON-a
    const err = `OpenRouter ${opts.model}: HTTP ${res.status}, nie-JSON: ${raw.slice(0, 200)}`;
    await failed(err);
    throw new Error(err);
  }
  if (!res.ok || json.error) {
    const err = `OpenRouter ${opts.model}: HTTP ${res.status}: ${json.error?.message ?? "unknown error"}`;
    await failed(err);
    throw new Error(err);
  }

  const usage = {
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    costUsd: json.usage?.cost ?? 0,
  };
  tally.calls += 1;
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
  tally.costUsd += usage.costUsd;
  addTask(opts.task, usage);

  const response = json.choices?.[0]?.message?.content ?? "";
  await record({ ...base, response, usage, ms: ms(), ok: true });
  return response;
}

/** Obraz (plakat) jako data-URL do części multimodalnej. */
export function imagePart(base64: string, mediaType: "image/jpeg" | "image/png"): ImagePart {
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } };
}
