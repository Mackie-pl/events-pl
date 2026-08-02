/** Wywołania modelu wyciągające wydarzenia z tekstu strony albo z plakatu. */
import { Value } from "@sinclair/typebox/value";

import { MODEL_EXTRACT, chat, imagePart, wasTruncated } from "../../adapters/openrouter.js";
import { audit } from "../../shared/audit.js";
import { salvageArray } from "../../shared/json-salvage.js";
import { fillMissing, toWireSchema } from "../../shared/json-schema.js";
import { EventSchema, ExtractionSchema } from "../../types/event-schema.js";
import type { EventItem, ExtractionResult, Followup } from "../../types/index.js";
import { POSTER_SYSTEM, extractionSystem } from "../prompts.js";

const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

/**
 * Sufit odpowiedzi. 4000 (poprzednia wartość) mieściło ~30 wydarzeń i cicho ucinało resztę:
 * strona z pełnym kalendarium przekraczała go razem z całą swoją zawartością, bo `JSON.parse`
 * na uciętej tablicy rzuca, a parser zwracał wtedy pustą listę. Trzy poznańskie portale
 * (`poznan-events`, `estrada`, `poznan-kultura`) trafiały w ten limit CO DO TOKENA każdego dnia.
 *
 * Podniesienie sufitu samo w sobie nie kosztuje — płacimy za tokeny faktycznie wygenerowane.
 */
const MAX_TOKENS = Number(process.env["EXTRACT_MAX_TOKENS"] ?? 12_000);

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

/**
 * Eksportowane dla testów.
 *
 * `truncated` przychodzi z zewnątrz, bo tylko wywołujący zna `finish_reason` odpowiedzi —
 * a to jedyne, co odróżnia „model wypisał zły JSON" od „przerwaliśmy go w połowie tablicy".
 * Przy ucięciu ratujemy kompletne rekordy sprzed miejsca przerwania: wywołanie już kosztowało,
 * a wyrzucenie trzydziestu poprawnych wydarzeń razem z jednym niedokończonym jest czystą stratą.
 */
export function parseModelJson(s: string, truncated = false): ExtractionResult {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [], parse: "no-json" };
  try {
    const parsed = JSON.parse(m[0]) as { events?: unknown; followups?: Followup[] };
    const events = keepValid(parsed.events);
    return parsed.followups ? { events, followups: parsed.followups } : { events };
  } catch {
    const events = keepValid(salvageArray(s, "events"));
    // followupy przepadają: siedzą za tablicą wydarzeń, więc ucięcie zabiera je zawsze
    return { events, parse: truncated ? "truncated" : "bad-json", recovered: events.length };
  }
}

export async function extractEvents(text: string, sourceUrl: string): Promise<ExtractionResult> {
  const sent = Math.min(text.length, MAX_INPUT_CHARS);
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
    maxTokens: MAX_TOKENS,
    schema: RESPONSE_SCHEMA,
  });
  const result = parseModelJson(out, wasTruncated());
  audit("llm", text.length > MAX_INPUT_CHARS
    ? `ekstrakcja z ${sent} znaków (treść ucięta z ${text.length}) → ${result.events.length} wydarzeń`
    : `ekstrakcja z ${sent} znaków → ${result.events.length} wydarzeń`,
  { model: MODEL_EXTRACT, task: "extract", chars: sent, events: result.events.length, url: sourceUrl });
  if (result.parse) {
    // osobny krok śladu: „zero wydarzeń" i „zero wydarzeń, bo nie dało się odczytać odpowiedzi"
    // wyglądały dotąd tak samo, a druga diagnoza jest naprawą w kodzie, nie w serwisie
    audit("llm", result.parse === "truncated"
      ? `odpowiedź ucięta na limicie ${MAX_TOKENS} tok. — odzyskano ${result.recovered ?? 0} wydarzeń` +
        " (podnieś EXTRACT_MAX_TOKENS)"
      : `nie dało się odczytać odpowiedzi modelu (${result.parse})`,
    { task: "extract", url: sourceUrl, why: result.parse });
  }
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
  const result = parseModelJson(out, wasTruncated());
  audit("llm", `odczyt plakatu (${img.mediaType}) → ${result.events.length} wydarzeń`,
    { model: MODEL_EXTRACT, task: "poster", events: result.events.length, url: sourceUrl });
  return result;
}
