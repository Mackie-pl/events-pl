/**
 * Cienki klient OpenRouter (OpenAI-compatible chat completions).
 * Modele wybierane przez env — łatwa ewaluacja różnych modeli bez zmian w kodzie:
 *   OPENROUTER_API_KEY  (wymagany)
 *   MODEL_EXTRACT       default: anthropic/claude-haiku-4.5   (tani, codzienna ekstrakcja)
 *   MODEL_DISCOVER      default: anthropic/claude-sonnet-4.6  (mocny, miesięczne discovery)
 */

import type { LlmUsage } from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const MODEL_EXTRACT = process.env["MODEL_EXTRACT"] ?? "anthropic/claude-haiku-4.5";
export const MODEL_DISCOVER = process.env["MODEL_DISCOVER"] ?? "anthropic/claude-sonnet-4.6";

/**
 * Akumulator zużycia LLM. Wywołania chat() są sekwencyjne (await) — bez współbieżności,
 * więc prosty licznik modułowy wystarcza. daily.ts robi resetUsage() przed każdym źródłem
 * i snapshotUsage() po, żeby przypisać tokeny/koszt do konkretnego źródła.
 */
const tally: LlmUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

export function resetUsage(): void {
  tally.calls = 0;
  tally.promptTokens = 0;
  tally.completionTokens = 0;
  tally.costUsd = 0;
}

export function snapshotUsage(): LlmUsage {
  return { ...tally };
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
export type UserContent = string | Array<TextPart | ImagePart>;

export interface ChatOptions {
  model: string;
  system: string;
  user: UserContent;
  maxTokens?: number;
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

export async function chat(opts: ChatOptions): Promise<string> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("Brak OPENROUTER_API_KEY");

  const res = await fetch(OPENROUTER_URL, {
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
    signal: AbortSignal.timeout(120_000),
  });

  const json = (await res.json()) as ChatCompletionResponse;
  if (!res.ok || json.error) {
    throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? "unknown error"}`);
  }
  tally.calls += 1;
  tally.promptTokens += json.usage?.prompt_tokens ?? 0;
  tally.completionTokens += json.usage?.completion_tokens ?? 0;
  tally.costUsd += json.usage?.cost ?? 0;
  return json.choices?.[0]?.message?.content ?? "";
}

/** Obraz (plakat) jako data-URL do części multimodalnej. */
export function imagePart(base64: string, mediaType: "image/jpeg" | "image/png"): ImagePart {
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } };
}
