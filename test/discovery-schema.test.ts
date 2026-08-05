/**
 * Schemat propozycji źródła jedzie na drut jako `response_format` discovery — czyli tam,
 * gdzie błąd nie wychodzi u nas, tylko na płatnym przebiegu crona, jako 400 od dostawcy
 * albo (gorzej) jako cicha zmiana tego, co model zwraca.
 *
 * Testy pilnują trzech rzeczy, których tsc nie widzi:
 *   1. wymogów trybu strict — te same, co dla schematu wydarzenia,
 *   2. zgodności schematu z PROMPTEM: DISCOVERY_SYSTEM opisuje kształt prozą, a schemat
 *      wymusza go maszynowo; rozjechane byłyby ciche, bo wygrywa schemat,
 *   3. zgodności schematu z toSource(), czyli z barierą przy wejściu do rejestru.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { toSource } from "../src/pipeline/discover/to-source.js";
import { DISCOVERY_SYSTEM } from "../src/pipeline/prompts.js";
import { countUnionParams, toWireSchema } from "../src/shared/json-schema.js";
import {
  DiscoverySchema, FETCH_STRATEGIES, SOURCE_TYPES, SourceProposalSchema,
} from "../src/types/source-schema.js";

/** Słowa kluczowe, których structured outputs nie obsługują — obecność = błąd 400 w locie. */
const UNSUPPORTED = ["pattern", "minimum", "maximum", "minLength", "maxLength", "multipleOf", "$ref"];

function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  out.push(obj);
  for (const value of Object.values(obj)) walk(value, out);
  return out;
}

const FIELDS = Object.keys(SourceProposalSchema.properties);

describe("schemat discovery na drucie (structured outputs, tryb strict)", () => {
  const wire = toWireSchema(DiscoverySchema);
  const nodes = walk(wire);

  it("każdy obiekt jest zamknięty na dodatkowe pola", () => {
    const objects = nodes.filter((n) => n["type"] === "object");
    assert.ok(objects.length > 0, "schemat bez obiektów — coś jest nie tak z walkiem");
    for (const node of objects) {
      assert.equal(node["additionalProperties"], false,
        `obiekt bez additionalProperties:false: ${JSON.stringify(Object.keys(node["properties"] ?? {}))}`);
    }
  });

  it('każde pole jest wymagane — „brak" wyrażamy pustym stringiem, nie pominięciem klucza', () => {
    for (const node of nodes.filter((n) => n["type"] === "object")) {
      const props = Object.keys(node["properties"] ?? {});
      const required = (node["required"] ?? []) as string[];
      assert.deepEqual([...required].sort(), [...props].sort());
    }
  });

  it("nie używa słów kluczowych, których structured outputs nie obsługują", () => {
    for (const node of nodes) {
      for (const keyword of UNSUPPORTED) {
        assert.ok(!(keyword in node), `niedozwolone słowo kluczowe "${keyword}" w schemacie`);
      }
    }
  });

  /**
   * `type` i `fetch` to listy wartości, a listę da się zapisać dwojako: unią literałów
   * albo `enum`. Unia liczy się do twardego limitu Anthropic („limit: 16 parameters with
   * unions"), `enum` nie kosztuje nic — stąd wybór i stąd ten test, bo zamiana jednego
   * na drugie wygląda przy przeglądaniu diffa na kosmetykę.
   */
  it("wartości słownikowe idą przez enum, nie przez unię", () => {
    assert.equal(countUnionParams(wire), 0, "unia w schemacie, którego całość da się opisać enumem");
    const props = nodes
      .map((n) => n["properties"])
      .find((p): p is Record<string, { enum?: unknown }> =>
        typeof p === "object" && p !== null && "url" in p);
    assert.ok(props, "nie znaleziono obiektu propozycji w schemacie");
    assert.deepEqual(props["type"]?.enum, [...SOURCE_TYPES]);
    assert.deepEqual(props["fetch"]?.enum, [...FETCH_STRATEGIES]);
  });
});

describe("schemat discovery a prompt", () => {
  it("prompt wymienia każde pole, o które prosi schemat", () => {
    for (const field of FIELDS) {
      assert.ok(DISCOVERY_SYSTEM.includes(`"${field}"`), `DISCOVERY_SYSTEM nie wspomina o polu "${field}"`);
    }
  });

  it("każdy `type` oferowany w prompcie jest dopuszczony przez schemat", () => {
    // wiersz „Typy: city_portal, culture_center, …" — prompt jest tu jedyną instrukcją
    // dla modelu, a schemat jedynym egzekutorem; wartość tylko w jednym z nich to pułapka
    const listed = /Typy:\s*([^\n.]+)/.exec(DISCOVERY_SYSTEM)?.[1] ?? "";
    const types = listed.split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(types.length > 0, "nie znaleziono listy typów w prompcie");
    for (const type of types) {
      assert.ok((SOURCE_TYPES as readonly string[]).includes(type), `prompt oferuje type "${type}" spoza schematu`);
    }
  });

  it("każda strategia `fetch` oferowana w prompcie jest dopuszczona przez schemat", () => {
    const listed = /"fetch":\s*"([^"]+)"/.exec(DISCOVERY_SYSTEM)?.[1] ?? "";
    const strategies = listed.split("|").map((s) => s.trim()).filter(Boolean);
    assert.ok(strategies.length > 0, "nie znaleziono listy strategii w prompcie");
    for (const fetch of strategies) {
      assert.ok((FETCH_STRATEGIES as readonly string[]).includes(fetch),
        `prompt oferuje fetch "${fetch}" spoza schematu`);
    }
  });
});

describe("schemat discovery a toSource", () => {
  const base = { id: "x", name: "X", url: "https://x.pl", town: "Poznań", why: "bo tak", notes: "" };

  it("żadna wartość `type` ze schematu nie wymaga poprawki przy wejściu do rejestru", () => {
    for (const type of SOURCE_TYPES) {
      const r = toSource({ ...base, type, fetch: "plain" }, "Poznań");
      assert.ok(!("err" in r), `type "${type}" odrzucony: ${"err" in r ? r.err : ""}`);
      assert.deepEqual(r.fixes, [], `type "${type}" wymagał poprawki, choć schemat go dopuszcza`);
      assert.equal(r.src.type, type);
    }
  });

  it("żadna wartość `fetch` ze schematu nie wymaga poprawki przy wejściu do rejestru", () => {
    for (const fetch of FETCH_STRATEGIES) {
      const r = toSource({ ...base, type: "venue", fetch }, "Poznań");
      assert.ok(!("err" in r), `fetch "${fetch}" odrzucony: ${"err" in r ? r.err : ""}`);
      assert.deepEqual(r.fixes, [], `fetch "${fetch}" wymagał poprawki, choć schemat go dopuszcza`);
      assert.equal(r.src.fetch, fetch);
    }
  });

  /**
   * Granica odpowiedzialności: schemat wymusza KSZTAŁT, nie sens. Adres grupy FB spełnia
   * `type: "string"` w każdym wariancie, a i tak trzeba go sprowadzić do korzenia i przestawić
   * strategię — czyli toSource zostaje potrzebny mimo structured outputs.
   */
  it("nie zwalnia toSource z normalizacji adresów FB", () => {
    const r = toSource(
      { ...base, url: "https://www.facebook.com/groups/123/posts/456/", type: "venue", fetch: "plain" },
      "Poznań",
    );
    assert.ok(!("err" in r));
    assert.equal(r.src.url, "https://www.facebook.com/groups/123");
    assert.equal(r.src.fetch, "fb_group");
    assert.equal(r.src.type, "fb_group");
  });
});
