/**
 * Trzy operacje na JSON Schema. Dwie w stronę modelu, jedna z powrotem.
 *
 * renderSchemaBlock() zamienia schemat na zwięzłą notację, którą do tej pory pisaliśmy
 * w prompcie ręcznie („nazwa": typ, // uwaga). NIE wysyłamy do modelu surowego JSON Schema:
 * jest jakieś trzy razy droższy w tokenach niż ta notacja, a potok chodzi codziennie po
 * kilkudziesięciu źródłach.
 *
 * toWireSchema() zdejmuje `x-render` i `default` — nasze adnotacje, których nie ma na liście
 * słów kluczowych dopuszczonych przez structured outputs.
 *
 * fillMissing() idzie w drugą stronę: łata odpowiedź modelu PRZED walidacją.
 */
import type { TSchema } from "@sinclair/typebox";

/** Fragment JSON Schema w zakresie, w jakim czytają go funkcje z tego pliku. */
interface Node {
  "x-render"?: string;
  default?: unknown;
  description?: string;
  type?: string;
  const?: unknown;
  anyOf?: Node[];
  items?: Node;
  properties?: Record<string, Node>;
}

const PRIMITIVE: Record<string, string> = {
  string: "str", number: "num", integer: "int", boolean: "bool", null: "null",
};

/**
 * Głębokość, od której obiekty zwijamy do „{...}". Rozwinięty `age` w `sub_slots` daje
 * linię na 130 znaków i schemat przestaje być czytelny — a to on ma być w prompcie
 * najbardziej oczywistą rzeczą.
 */
const INLINE_DEPTH = 2;

/** Typ pola w notacji promptu: „str", „int|null", „[{...}]". */
function renderType(node: Node, depth: number): string {
  const hint = node["x-render"];
  if (hint !== undefined) return hint;
  if (node.anyOf) return node.anyOf.map((b) => renderType(b, depth)).join("|");
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.items) return `[${renderType(node.items, depth + 1)}]`;
  if (node.properties) {
    if (depth > INLINE_DEPTH) return "{...}";
    const fields = Object.entries(node.properties)
      .map(([key, value]) => `"${key}": ${renderType(value, depth + 1)}`);
    return `{${fields.join(", ")}}`;
  }
  return PRIMITIVE[node.type ?? ""] ?? "any";
}

/** Ile znaków ma najdłuższy prefiks, do którego warto wyrównać komentarze. */
const COMMENT_COLUMN_CAP = 46;

/**
 * Blok schematu do wklejenia w prompt. Wynik jest jedyną rzeczą, którą model widzi
 * z tego pliku — jeśli wygląda źle, wygląda źle dla modelu.
 */
export function renderSchemaBlock(schema: TSchema): string {
  const props = Object.entries((schema as Node).properties ?? {});
  const rows = props.map(([key, value], i) => ({
    prefix: ` "${key}": ${renderType(value, 1)}${i === props.length - 1 ? "" : ","}`,
    note: value.description,
  }));
  const column = Math.min(
    Math.max(...rows.filter((r) => r.note).map((r) => r.prefix.length), 0) + 2,
    COMMENT_COLUMN_CAP,
  );
  const lines = rows.map(({ prefix, note }) => {
    if (note === undefined) return prefix;
    return `${prefix}${" ".repeat(Math.max(column - prefix.length, 2))}// ${note}`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

/**
 * Ile pól ma typ unii. Anthropic kompiluje strict schema i przy unijnych polach koszt rośnie
 * wykładniczo, więc tnie na twardym limicie:
 *   „Schemas contains too many parameters with union types … (limit: 16 parameters with unions)".
 *
 * Liczy się KAŻDE wystąpienie po rozwinięciu, nie każda definicja: `age` użyte w dwóch
 * miejscach kosztuje dwa razy. Liczą się też `type: [...]`, więc zamiana `anyOf` na tablicę
 * typów niczego nie oszczędza — jedyną walutą jest mniej pól dopuszczających null.
 */
export function countUnionParams(schema: unknown): number {
  if (schema === null || typeof schema !== "object") return 0;
  if (Array.isArray(schema)) return schema.reduce<number>((n, item) => n + countUnionParams(item), 0);
  const node = schema as Node & { type?: unknown };
  const isUnion = Array.isArray(node.type) || Array.isArray(node.anyOf);
  return Object.values(node).reduce<number>(
    (n, value) => n + countUnionParams(value), isUnion ? 1 : 0,
  );
}

/** Adnotacje wyłącznie nasze — na drucie byłyby nieznanym słowem kluczowym. */
const OURS = new Set(["x-render", "default"]);

/** Schemat gotowy na drut, bez naszych prywatnych adnotacji. */
export function toWireSchema(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema, (key, value: unknown) =>
    OURS.has(key) ? undefined : value)) as unknown;
}

/** Czy schemat dopuszcza null — czyli czy „brak" da się w nim wyrazić. */
const allowsNull = (node: Node): boolean =>
  node.type === "null" || (node.anyOf?.some(allowsNull) ?? false);

/**
 * Czym zastąpić NIEOBECNE pole. Kolejność jest tu całą treścią decyzji:
 * jawny `default` (bo ktoś świadomie wybrał sensowną wartość) → null (bo schemat go dopuszcza,
 * więc „nie wiadomo" jest legalną odpowiedzią) → pusta tablica → obiekt wypełniony rekurencyjnie.
 * Gdy nic z tego nie pasuje, zwracamy undefined i pole ZOSTAJE nieobecne — walidacja je odrzuci.
 * Tak właśnie ma się zachować `title` i `date_start`: wydarzenie bez nich jest bezużyteczne.
 */
function emptyFor(node: Node): unknown {
  if (node.default !== undefined) return node.default;
  if (allowsNull(node)) return null;
  if (node.type === "array") return [];
  if (node.properties) return fillMissing(node as TSchema, {});
  return undefined;
}

/**
 * Uzupełnia brakujące pola odpowiedzi modelu wartościami „nie wiadomo".
 *
 * Bez tego kroku walidacja byłaby nie do użytku: schemat wymaga wszystkich pól (tego chce
 * tryb strict structured outputs), a model bez structured outputs regularnie oddaje sam
 * `{title, date_start}` i pomija resztę. Odrzucanie takich wpisów wyrzuciłoby wydarzenia,
 * które dziś normalnie przechodzą — czyli naprawa schematu popsułaby produkt.
 *
 * Łatamy WYŁĄCZNIE brak klucza. Klucz obecny z niewłaściwym typem (`date_start: 20260801`)
 * przechodzi dalej nietknięty i wywala się na walidacji — bo to nie jest brak informacji,
 * tylko informacja błędna, a zgadywanie po niej byłoby wymyślaniem danych.
 */
export function fillMissing(schema: TSchema, value: unknown): unknown {
  const node = schema as Node;
  if (node.type === "array" && node.items && Array.isArray(value)) {
    return value.map((item) => fillMissing(node.items as TSchema, item));
  }
  if (!node.properties || value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, child] of Object.entries(node.properties)) {
    if (out[key] === undefined) {
      const filled = emptyFor(child);
      if (filled !== undefined) out[key] = filled;
    } else {
      out[key] = fillMissing(child as TSchema, out[key]);
    }
  }
  return out;
}
