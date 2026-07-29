/**
 * Kształt wydarzenia — JEDNO źródło prawdy dla trzech rzeczy naraz:
 *   1. typu `EventItem` (przez Static<>; types/event.ts tylko dokłada pola dopisywane w potoku),
 *   2. bloku schematu w prompcie (shared/json-schema.ts renderuje z tego notację
 *      „nazwa": typ, // uwaga — tę samą, którą do tej pory pisaliśmy ręcznie w dwóch miejscach),
 *   3. `response_format` przy structured outputs.
 *
 * Dlaczego TypeBox, a nie zod: to, co tu piszemy, JEST JSON Schema — obiekt zwracany przez
 * Type.Object() leci na drut bez konwersji. Przy zodzie między nami a drutem stoi
 * z.toJSONSchema(), czyli warstwa, której wynik i tak trzeba by audytować pod kątem tego,
 * co structured outputs dopuszcza (np. `pattern` z .regex() nie jest tam obsługiwany).
 *
 * Dlaczego w types/, skoro to wartość, a nie typ: bo `EventItem` się z tego wywodzi.
 * Odwrotny kierunek (schemat w pipeline/) kazałby types/ importować z pipeline/.
 *
 * KAŻDE pole modelu jest wymagane, a „brak" to `null`, nie `?`. Dwa powody: tryb strict
 * structured outputs wymaga wszystkiego w `required` przy `additionalProperties: false`,
 * a przy okazji znika decyzja „pominąć klucz czy wstawić null", na której model bywał
 * niekonsekwentny.
 *
 * `description` to NIE dokumentacja dla nas — to treść promptu. Trafia do renderowanego
 * bloku, a przy structured outputs również na drut, w samym schemacie. Pisz ją tak, jakbyś
 * pisał prompt, bo nią jest.
 *
 * `x-render` to podpowiedź WYŁĄCZNIE dla renderera bloku: kształty typu „HH:MM" nie mają
 * odpowiednika wśród `format`ów dopuszczonych przez structured outputs, a `pattern` jest
 * tam nieobsługiwany. Klucz zdejmuje stripRenderHints() przed wysłaniem schematu.
 */
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";

/** YYYY-MM-DD — kontrakt events.json; wszystko inne to dla nas brak daty. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bez rejestracji TypeBox traktuje `format` jak adnotację i NIE sprawdza go w Value.Check —
 * czyli `date_start: "sierpień"` przeszedłby walidację. Rejestrujemy tu, obok schematu, który
 * ten format deklaruje: rozjechanie się tych dwóch miejsc jest ciche i kosztuje dzień danych.
 */
FormatRegistry.Set("date", (value) => ISO_DATE.test(value));

/** Obiekt zamknięty: `additionalProperties: false` to wymóg trybu strict, nie ozdoba. */
const closed = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });

/** „T albo null". Uwaga idzie na unię, nie na gałąź — renderer czyta description z pola. */
const orNull = <T extends TSchema>(schema: T, note?: string) =>
  Type.Union([schema, Type.Null()], note === undefined ? {} : { description: note });

const HHMM = { "x-render": '"HH:MM"' };
const ISO_DAY = { format: "date", "x-render": '"YYYY-MM-DD"' };

/**
 * Pole tekstowe, w którym „brak" to PUSTY STRING, nie null.
 *
 * Nie estetyka — budżet. Anthropic kompiluje strict schema i tnie na 16 polach unijnych
 * („limit: 16 parameters with unions"), a nasz komplet nullowalnych pól dawał 21. Płacimy
 * więc tam, gdzie różnica null vs "" i tak nigdzie nie jest czytana: każdy konsument tych
 * pięciu pól robi `filter(Boolean)` albo sprawdza prawdziwość, więc "" znaczy dokładnie to
 * samo, co znaczyło null. Liczbę pilnuje test — patrz test/event-schema.test.ts.
 *
 * Pola strukturalne (daty, godziny, price, age, sub_slots) zostają nullowalne: tam różnica
 * „nie wiadomo" vs „puste" jest realna i czytana przy filtrowaniu po zakresie dat.
 */
const orEmpty = (note: string) => Type.String({ default: "", description: `${note}; "" gdy brak` });

const AGE_NOTE = '„4+"→min:4; „roczniki 2015-2016"→przelicz na wiek; „dorośli"→min:18';
const TAGS_NOTE = 'zagnieżdżone, np. "dzieci:dmuchańce", "warsztaty:ceramika", "muzyka:koncert", '
  + '"sport:rower", "film:plener"';
const DATE_NOTE = "wywnioskuj rok z kontekstu; pomiń wydarzenia zakończone przed dzisiejszą datą";
const NOISE_NOTE = "komisje rady, wybory sołeckie, przetargi, ogłoszenia urzędowe → true";
const SLOTS_NOTE = "etapy wydarzenia (np. 12-18 dzieci, 18-22 dorośli)";
const CONTAINER_NOTE = 'nazwa wydarzenia-kontenera, z którego rozbito wpis; "" gdy samodzielne';
const REASON_NOTE = '"program PDF" | "szczegóły wydarzenia" | "plakat"';

export const AgeSchema = closed({
  min: orNull(Type.Integer()),
  max: orNull(Type.Integer()),
  label: orNull(Type.String(), 'oryginalny zapis, np. "4+"'),
});

export const PriceSchema = closed({
  free: orNull(Type.Boolean()),
  amount_pln: orNull(Type.Number()),
  note: orNull(Type.String()),
});

export const SubSlotSchema = closed({
  time: Type.String(HHMM),
  label: Type.String(),
  age: orNull(AgeSchema),
});

/** Wydarzenie tak, jak zwraca je model. Pola dopisywane później (geo, source_id) są w types/event.ts. */
export const EventSchema = closed({
  title: Type.String(),
  date_start: Type.String({ ...ISO_DAY, description: DATE_NOTE }),
  date_end: orNull(Type.String(ISO_DAY)),
  time_start: orNull(Type.String(HHMM)),
  time_end: orNull(Type.String(HHMM)),
  venue: orEmpty("pełna nazwa miejsca + adres jeśli podany"),
  town: orEmpty("miejscowość"),
  price: PriceSchema,
  age: orNull(AgeSchema, AGE_NOTE),
  // `default` czyta wyłącznie fillMissing(), gdy modelowi umknie klucz; toWireSchema() go zdejmuje.
  // „maybe" to nie wygodny fallback, tylko właściwa odpowiedź na „model nie napisał".
  family_friendly: Type.Union([Type.Boolean(), Type.Literal("maybe")], { default: "maybe" }),
  tags: Type.Array(Type.String(), { description: TAGS_NOTE }),
  registration: orEmpty("telefon/link do zapisów jeśli jest"),
  sub_slots: orNull(Type.Array(SubSlotSchema), SLOTS_NOTE),
  conditional: orEmpty('np. "przy deszczu przeniesione na 26.07"'),
  container: Type.String({ default: "", description: CONTAINER_NOTE }),
  // pusty string, a nie null — ten sam sentynel, co w facebook.ts dla wydarzeń bez linku
  source_url: Type.String({ default: "" }),
  is_noise: Type.Boolean({ description: NOISE_NOTE, default: false }),
});

export const FollowupSchema = closed({
  url: Type.String(),
  reason: Type.String({ description: REASON_NOTE }),
});

/** Całość odpowiedzi modelu — to ten schemat idzie do `response_format`. */
export const ExtractionSchema = closed({
  events: Type.Array(EventSchema),
  followups: Type.Array(FollowupSchema),
});

export type ModelEvent = Static<typeof EventSchema>;
export type AgeRange = Static<typeof AgeSchema>;
export type Price = Static<typeof PriceSchema>;
export type SubSlot = Static<typeof SubSlotSchema>;
export type Followup = Static<typeof FollowupSchema>;
