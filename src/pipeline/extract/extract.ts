/** Wywołania modelu wyciągające wydarzenia z tekstu strony albo z plakatu. */
import { MODEL_EXTRACT, chat, imagePart } from "../../adapters/openrouter.js";
import type { ExtractionResult } from "../../types/index.js";
import { POSTER_SYSTEM, extractionSystem } from "../prompts.js";

const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

function parseJson(s: string): ExtractionResult {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [] };
  try {
    return JSON.parse(m[0]) as ExtractionResult;
  } catch {
    return { events: [] };
  }
}

export async function extractEvents(text: string, sourceUrl: string): Promise<ExtractionResult> {
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
    maxTokens: 4000,
  });
  return parseJson(out);
}

export async function extractPoster(
  img: { data: string; mediaType: "image/jpeg" | "image/png" },
  sourceUrl: string,
): Promise<ExtractionResult> {
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "poster",
    system: POSTER_SYSTEM,
    user: [imagePart(img.data, img.mediaType), { type: "text", text: `ŹRÓDŁO: ${sourceUrl}` }],
    maxTokens: 2000,
  });
  return parseJson(out);
}
