/** Wywołania modelu wyciągające wydarzenia z tekstu strony albo z plakatu. */
import { Value } from "@sinclair/typebox/value";

import { MODEL_EXTRACT, chat, imagePart } from "../../adapters/openrouter.js";
import { audit } from "../../shared/audit.js";
import { fillMissing, toWireSchema } from "../../shared/json-schema.js";
import { EventSchema, ExtractionSchema } from "../../types/event-schema.js";
import type { EventItem, ExtractionResult, Followup } from "../../types/index.js";
import { POSTER_SYSTEM, extractionSystem } from "../prompts.js";

const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

/**
 * Schemat wysyłany jako `response_format` — ten sam obiekt, z którego renderuje się blok
 * w prompcie. Liczony raz: jest stały, a przy każdym źródle serializowalibyśmy go od nowa.
 *
 * Zwróć uwagę, że prompt NADAL zawiera blok schematu, mimo że przy structured outputs jest
 * teoretycznie zbędny. To świadome: flaga bywa wyłączona, a dwa warianty promptu (z blokiem
 * i bez) to dwa zachowania modelu do porównania — na to trzeba evala, nie refaktoru.
 */
const RESPONSE_SCHEMA = { name: "wydarzenia", schema: toWireSchema(ExtractionSchema) };

/**
 * Ile wydarzeń odrzucono w tym źródle na walidacji. Licznik modułowy, jak w adapterach —
 * granicę „jednego źródła" wyznacza processSource, które resetuje go razem z resetUsage().
 */
let droppedInvalid = 0;

export const droppedInvalidStats = (): number => droppedInvalid;
export function resetDroppedInvalid(): void { droppedInvalid = 0; }

/**
 * Dlaczego ten wpis odpadł, jednym zdaniem po polsku. Ślad ma odpowiadać na „co model
 * znowu zrobił", więc sam licznik nie wystarcza — najczęstszy przypadek (atrakcja stała
 * bez daty) dostaje własne zdanie, reszta ścieżkę pola prosto z walidatora.
 */
function whyRejected(raw: unknown): string {
  const date = (raw as { date_start?: unknown } | null)?.date_start;
  if (date === undefined || date === null || date === "") return "brak daty startu, to atrakcja stała";
  const first = [...Value.Errors(EventSchema, raw)][0];
  if (!first) return "nie pasuje do schematu wydarzenia";
  return `pole ${first.path || "/"} nie pasuje do schematu (${first.message})`;
}

/**
 * Jedyna granica, na której nie ufamy odpowiedzi modelu.
 *
 * Do lipca 2026 stał tu wyłącznie test na `date_start`, a reszta pól szła dalej na `as` —
 * czyli `price: "za darmo"` trafiało prosto do events.json. Teraz sprawdzamy cały kształt
 * tym samym schematem, którym opisujemy go modelowi.
 *
 * Kolejność jest istotna: najpierw fillMissing (pominięty klucz to brak informacji, nie błąd),
 * dopiero potem Check. Odwrotnie odrzucalibyśmy wydarzenia, które dziś normalnie przechodzą.
 */
function keepValid(events: unknown): EventItem[] {
  if (!Array.isArray(events)) return [];
  const kept: EventItem[] = [];
  for (const raw of events) {
    const filled = fillMissing(EventSchema, raw);
    if (Value.Check(EventSchema, filled)) {
      kept.push(filled); // Value.Check to type guard — dalej mamy już Static<typeof EventSchema>
      continue;
    }
    droppedInvalid += 1;
    // ślad dostaje TYTUŁ, nie tylko licznik: „model znowu wrzucił zoo" widać dopiero po nazwie
    const title = (raw as { title?: unknown } | null)?.title;
    audit("event.dropped", `„${typeof title === "string" ? title : "(bez tytułu)"}" — ${whyRejected(filled)}`,
      { title: typeof title === "string" ? title : null, why: whyRejected(filled) });
  }
  return kept;
}

/** Eksportowane dla testów. */
export function parseModelJson(s: string): ExtractionResult {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [] };
  try {
    const parsed = JSON.parse(m[0]) as { events?: unknown; followups?: Followup[] };
    const events = keepValid(parsed.events);
    return parsed.followups ? { events, followups: parsed.followups } : { events };
  } catch {
    return { events: [] };
  }
}

export async function extractEvents(text: string, sourceUrl: string): Promise<ExtractionResult> {
  const sent = Math.min(text.length, MAX_INPUT_CHARS);
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
    maxTokens: 4000,
    schema: RESPONSE_SCHEMA,
  });
  const result = parseModelJson(out);
  audit("llm", text.length > MAX_INPUT_CHARS
    ? `ekstrakcja z ${sent} znaków (treść ucięta z ${text.length}) → ${result.events.length} wydarzeń`
    : `ekstrakcja z ${sent} znaków → ${result.events.length} wydarzeń`,
  { model: MODEL_EXTRACT, task: "extract", chars: sent, events: result.events.length, url: sourceUrl });
  return result;
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
    schema: RESPONSE_SCHEMA,
  });
  const result = parseModelJson(out);
  audit("llm", `odczyt plakatu (${img.mediaType}) → ${result.events.length} wydarzeń`,
    { model: MODEL_EXTRACT, task: "poster", events: result.events.length, url: sourceUrl });
  return result;
}
