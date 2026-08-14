/**
 * Wywołania modelu wyciągające wydarzenia z tekstu strony albo z plakatu.
 *
 * Zwracają DOKŁADNIE to, co powiedział model — z `repeat` na drucie i bez rozwinięcia rytmu.
 * Rozwinięcie stało tu do 2026-08 i było błędem: wynik tych funkcji idzie prosto do cache'a
 * kluczowanego hashem treści, a `expandRepeat` zależy od „dziś", więc cache zapisywał wartość
 * zależną od wejścia, którego nie miał w kluczu. Rozwijaniem zajmuje się teraz wyjście
 * z processSource — patrz nagłówek pipeline/series.ts.
 */
import { Value } from "@sinclair/typebox/value";

import {
  MODEL_EXTRACT, callDetail, chat, imagePart, wasTruncated,
} from "../../adapters/openrouter.js";
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { salvageArray } from "../../shared/json-salvage.js";
import { fillMissing, toWireSchema } from "../../shared/json-schema.js";
import { BatchExtractionSchema, EventSchema, ExtractionSchema } from "../../types/event-schema.js";
import type { EventItem, ExtractionResult, Followup } from "../../types/index.js";
import { POSTER_SYSTEM, batchExtractionSystem, extractionSystem } from "../prompts.js";

import { keepFoundedDates } from "./date-hint.js";

const MAX_INPUT_CHARS = 40_000; // ~10k tokenów

/**
 * Sufit odpowiedzi. 4000 (poprzednia wartość) mieściło ~30 wydarzeń i cicho ucinało resztę:
 * strona z pełnym kalendarium przekraczała go razem z całą swoją zawartością, bo `JSON.parse`
 * na uciętej tablicy rzuca, a parser zwracał wtedy pustą listę. Trzy poznańskie portale
 * (`poznan-events`, `estrada`, `poznan-kultura`) trafiały w ten limit CO DO TOKENA każdego dnia.
 *
 * Podniesienie sufitu samo w sobie nie kosztuje — płacimy za tokeny faktycznie wygenerowane.
 */
const MAX_TOKENS = (): number => P.EXTRACT_MAX_TOKENS.get();

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
 * Bezpiecznik na zmyśloną datę (date-hint.ts) doliczony do tego samego licznika, co odrzuty
 * walidacji: dla raportu przebiegu obie ścieżki znaczą to samo — tyle wpisów model oddał,
 * a potok ich nie przyjął. Rozróżnienie zostaje w śladzie, gdzie widać KTÓRE i dlaczego.
 */
function keepFounded(events: EventItem[], text: string): EventItem[] {
  const kept = keepFoundedDates(events, text);
  droppedInvalid += events.length - kept.length;
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
/**
 * Odpowiedź modelu SUROWO, przed walidacją — potrzebna wywołaniu zbiorczemu, bo numer bloku
 * trzeba zdjąć z wpisu, ZANIM ten trafi do `keepValid`. Schemat wydarzenia jest zamknięty
 * (`additionalProperties: false`), więc wpis z dodatkowym polem `block` nie przechodzi
 * walidacji — bez tego rozdzielenia paczka gubiłaby wszystkie wydarzenia co do jednego.
 */
function parseRaw(s: string, truncated: boolean): {
  events: unknown[]; followups?: Followup[]; parse?: ExtractionResult["parse"];
} {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { events: [], parse: "no-json" };
  try {
    const parsed = JSON.parse(m[0]) as { events?: unknown; followups?: Followup[] };
    const events = Array.isArray(parsed.events) ? (parsed.events as unknown[]) : [];
    return parsed.followups ? { events, followups: parsed.followups } : { events };
  } catch {
    // followupy przepadają: siedzą za tablicą wydarzeń, więc ucięcie zabiera je zawsze
    const salvaged = salvageArray(s, "events");
    return {
      events: Array.isArray(salvaged) ? salvaged : [],
      parse: truncated ? "truncated" : "bad-json",
    };
  }
}

export function parseModelJson(s: string, truncated = false): ExtractionResult {
  const raw = parseRaw(s, truncated);
  const events = keepValid(raw.events);
  if (raw.parse === "no-json") return { events: [], parse: "no-json" };
  if (raw.parse) return { events, parse: raw.parse, recovered: events.length };
  return raw.followups ? { events, followups: raw.followups } : { events };
}

export async function extractEvents(text: string, sourceUrl: string): Promise<ExtractionResult> {
  const sent = Math.min(text.length, MAX_INPUT_CHARS);
  const seen = text.slice(0, MAX_INPUT_CHARS);
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${seen}`,
    maxTokens: MAX_TOKENS(),
    schema: RESPONSE_SCHEMA,
    temperature: 0,
  });
  const parsed = parseModelJson(out, wasTruncated());
  // dowodem jest TYLKO to, co model zobaczył — nie cały `text`, jeśli ucięliśmy go na limicie
  const result: ExtractionResult = { ...parsed, events: keepFounded(parsed.events, seen) };
  audit("llm", text.length > MAX_INPUT_CHARS
    ? `ekstrakcja z ${sent} znaków (treść ucięta z ${text.length}) → ${result.events.length} wydarzeń`
    : `ekstrakcja z ${sent} znaków → ${result.events.length} wydarzeń`,
  { model: MODEL_EXTRACT, task: "extract", chars: sent, events: result.events.length, url: sourceUrl,
    ...callDetail() });
  if (result.parse) {
    // osobny krok śladu: „zero wydarzeń" i „zero wydarzeń, bo nie dało się odczytać odpowiedzi"
    // wyglądały dotąd tak samo, a druga diagnoza jest naprawą w kodzie, nie w serwisie
    audit("llm", result.parse === "truncated"
      ? `odpowiedź ucięta na limicie ${MAX_TOKENS()} tok. — odzyskano ${result.recovered ?? 0} wydarzeń` +
        " (podnieś EXTRACT_MAX_TOKENS)"
      : `nie dało się odczytać odpowiedzi modelu (${result.parse})`,
    { task: "extract", url: sourceUrl, why: result.parse });
  }
  return result;
}

/** Wynik wywołania zbiorczego rozpisany z powrotem na bloki; klucz = indeks w paczce. */
export interface BatchResult {
  byBlock: Map<number, { events: EventItem[]; followups: string[] }>;
  /**
   * Indeksy, których NIE WOLNO zapisać do cache'a, bo odpowiedź urwała się na limicie
   * i nie wiadomo, czy ich wynik jest kompletny. Puste przy zdrowej odpowiedzi.
   */
  unsafe: Set<number>;
  parse?: ExtractionResult["parse"];
}

const RESPONSE_SCHEMA_BATCH = { name: "wydarzenia_blokowe", schema: toWireSchema(BatchExtractionSchema) };

/** „BLOK 0:\n…" — nagłówek, z którego model przepisuje numer do pola `block`. */
export const withHeaders = (texts: string[]): string =>
  texts.map((t, i) => `BLOK ${i}:\n${t}`).join("\n\n");

/**
 * Ucięcie odpowiedzi to jedyny moment, w którym paczka jest groźniejsza od wywołań na blok.
 *
 * Przy uciętej odpowiedzi bloki z KOŃCA paczki albo nie zdążyły się pojawić, albo pojawiły
 * się w połowie — a zapisanie ich jako „zero wydarzeń" zatrułoby cache na wiele dni:
 * blok byłby uznany za przeczytany i nigdy nie wróciłby do modelu. Dlatego za pewny uznajemy
 * wyłącznie blok o indeksie MNIEJSZYM niż największy widziany: skoro model przeszedł już do
 * następnego, poprzedni ma komplet. Reszta zostaje nieznana i pójdzie jutro jeszcze raz.
 */
export function safeUpTo(indices: number[], truncated: boolean, size: number): Set<number> {
  if (!truncated) return new Set();
  const max = indices.length ? Math.max(...indices) : -1;
  const unsafe = new Set<number>();
  for (let i = Math.max(max, 0); i < size; i++) unsafe.add(i);
  return unsafe;
}

/**
 * Rozpisanie surowej odpowiedzi na bloki. Wydzielone z `extractBatch`, bo to tutaj mieszka
 * cała logika przypisania — a przy modelu w środku nie dałoby się jej przetestować.
 */
export function mapBatch(
  rawEvents: unknown[], rawFollowups: Followup[], count: number, truncated: boolean,
): BatchResult & { kept: number; orphans: number } {
  const byBlock = new Map<number, { events: EventItem[]; followups: string[] }>();
  for (let i = 0; i < count; i++) byBlock.set(i, { events: [], followups: [] });

  const seen: number[] = [];
  /** Numer bloku z wpisu; `null` = model go nie podał albo podał bzdurę — wpis przepada. */
  const slotOf = (raw: unknown): { events: EventItem[]; followups: string[] } | null => {
    const n = (raw as { block?: unknown } | null)?.block;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= count) return null;
    seen.push(n);
    return byBlock.get(n) ?? null;
  };

  let kept = 0, orphans = 0;
  for (const raw of rawEvents) {
    const target = slotOf(raw);
    if (!target) { orphans += 1; continue; }
    // `block` MUSI zniknąć przed walidacją — schemat wydarzenia jest zamknięty
    const { block: _drop, ...rest } = raw as Record<string, unknown>;
    const valid = keepValid([rest]);
    if (valid.length) { target.events.push(valid[0]!); kept += 1; }
  }
  for (const f of rawFollowups) {
    const target = slotOf(f);
    if (target && f.url && !target.followups.includes(f.url)) target.followups.push(f.url);
  }
  return { byBlock, unsafe: safeUpTo(seen, truncated, count), kept, orphans };
}

/**
 * Jedno wywołanie na WIELE bloków. Zwraca wynik rozpisany po blokach — wpisy bez poprawnego
 * numeru przepadają, bo cache bez przypisania jest gorszy niż jego brak.
 */
export async function extractBatch(texts: string[], sourceUrl: string): Promise<BatchResult> {
  const seen = withHeaders(texts).slice(0, MAX_INPUT_CHARS);
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "extract",
    system: batchExtractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: ${sourceUrl}\n\n${seen}`,
    maxTokens: MAX_TOKENS(),
    schema: RESPONSE_SCHEMA_BATCH,
    temperature: 0,
  });
  const truncated = wasTruncated();
  const parsed = parseRaw(out, truncated);
  const { byBlock, unsafe, orphans } =
    mapBatch(parsed.events, parsed.followups ?? [], texts.length, truncated);

  // PRZED zapisem do cache'a (block-source.ts), bo cache trzyma wynik bloku na wiele dni:
  // wpuszczona tu zmyślona data wracałaby potem bez ani jednego wywołania modelu
  let kept = 0;
  for (const slot of byBlock.values()) {
    slot.events = keepFounded(slot.events, seen);
    kept += slot.events.length;
  }

  audit("llm", `paczka ${texts.length} bloków → ${kept} wydarzeń` +
    (orphans ? `, ${orphans} bez poprawnego numeru bloku (odrzucone)` : "") +
    (unsafe.size ? `, ${unsafe.size} bloków bez pewnego wyniku (odpowiedź ucięta)` : ""),
  { model: MODEL_EXTRACT, task: "extract", blocks: texts.length, events: kept,
    orphans, unsafe: unsafe.size, url: sourceUrl, ...callDetail() });
  if (parsed.parse) {
    audit("llm", parsed.parse === "truncated"
      ? `odpowiedź ucięta na limicie ${MAX_TOKENS()} tok. — odzyskano ${kept} wydarzeń`
      : `nie dało się odczytać odpowiedzi modelu (${parsed.parse})`,
    { task: "extract", url: sourceUrl, why: parsed.parse });
  }

  return { byBlock, unsafe, ...(parsed.parse ? { parse: parsed.parse } : {}) };
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
    temperature: 0,
  });
  const result = parseModelJson(out, wasTruncated());
  audit("llm", `odczyt plakatu (${img.mediaType}) → ${result.events.length} wydarzeń`,
    { model: MODEL_EXTRACT, task: "poster", events: result.events.length, url: sourceUrl,
      ...callDetail() });
  return result;
}
