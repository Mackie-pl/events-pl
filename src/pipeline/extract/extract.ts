/** Wywołania modelu wyciągające wydarzenia z tekstu strony albo z plakatu. */
import { MODEL_EXTRACT, chat, imagePart } from "../../adapters/openrouter.js";
import type { EventItem, ExtractionResult } from "../../types/index.js";
import { POSTER_SYSTEM, extractionSystem } from "../prompts.js";

const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

/** YYYY-MM-DD — kontrakt events.json; wszystko inne to dla nas brak daty. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ile wydarzeń odrzucono w tym źródle z braku daty. Licznik modułowy, jak w adapterach —
 * granicę „jednego źródła" wyznacza processSource, które resetuje go razem z resetUsage().
 */
let droppedNoDate = 0;

export const droppedNoDateStats = (): number => droppedNoDate;
export function resetDroppedNoDate(): void { droppedNoDate = 0; }

/**
 * Wydarzenie bez daty startu jest bezużyteczne: serwis odpowiada na „co się dzieje jutro
 * i w weekend", a digest filtruje po zakresie dat. Model mimo promptu zwraca czasem
 * atrakcje stałe (zoo, place zabaw, parki linowe) — od tego są mapy, nie ten serwis.
 *
 * Odrzucamy je TU, na granicy nieufności do odpowiedzi modelu, zamiast wpuszczać dalej:
 * typ obiecuje `date_start: string`, więc null przeciekał do events.json i cicho znikał
 * z digestu przy porównaniu `null <= "2026-08-02"` (fałsz) — bez błędu i bez śladu.
 */
function keepDated(events: EventItem[]): EventItem[] {
  if (!Array.isArray(events)) return [];
  const kept = events.filter((e) => typeof e?.date_start === "string" && ISO_DATE.test(e.date_start));
  droppedNoDate += events.length - kept.length;
  return kept;
}

/** Eksportowane dla testów: to jedyna granica, na której nie ufamy odpowiedzi modelu. */
export function parseModelJson(s: string): ExtractionResult {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [] };
  try {
    const parsed = JSON.parse(m[0]) as ExtractionResult;
    return { ...parsed, events: keepDated(parsed.events) };
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
  return parseModelJson(out);
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
  return parseModelJson(out);
}
