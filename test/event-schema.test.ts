/**
 * Schemat wydarzenia obsługuje trzech konsumentów naraz (typ, prompt, `response_format`),
 * więc pęknięcie dowolnego z nich jest ciche: typ dalej się kompiluje, prompt dalej się
 * renderuje, a model po prostu zaczyna zwracać co innego. Te testy pilnują dwóch rzeczy,
 * których tsc nie widzi.
 *
 * 1. Blok w prompcie faktycznie opisuje WSZYSTKIE pola — i trafia do OBU promptów.
 *    Regresja z lipca 2026: POSTER_SYSTEM odsyłał do „tego samego schematu JSON",
 *    nie mając go w kontekście.
 * 2. Schemat spełnia wymogi trybu strict structured outputs. To kontrakt z API, nie
 *    nasza konwencja: `pattern` albo brakujące `required` wywala wywołanie dopiero
 *    w locie, na płatnym przebiegu.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { POSTER_SYSTEM, extractionSystem } from "../src/pipeline/prompts.js";
import { countUnionParams, renderSchemaBlock, toWireSchema } from "../src/shared/json-schema.js";
import { EventSchema, ExtractionSchema } from "../src/types/event-schema.js";

const block = renderSchemaBlock(EventSchema);

/** Słowa kluczowe, których structured outputs nie obsługują — obecność = błąd 400 w locie. */
const UNSUPPORTED = ["pattern", "minimum", "maximum", "minLength", "maxLength", "multipleOf", "$ref"];

/** Wszystkie węzły schematu, żeby asercje nie zatrzymywały się na pierwszym poziomie. */
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

describe("blok schematu w prompcie", () => {
  it("wymienia każde pole, które model ma zwrócić", () => {
    for (const key of Object.keys(EventSchema.properties)) {
      assert.ok(block.includes(`"${key}"`), `brak pola "${key}" w bloku promptu`);
    }
  });

  it("przenosi uwagi (description) jako komentarze — to one niosą instrukcje", () => {
    assert.match(block, /„4\+"→min:4/);
    assert.match(block, /komisje rady/);
  });

  it("zwija zbyt głęboko zagnieżdżone obiekty, zamiast rozwlekać linię", () => {
    assert.ok(block.includes('"sub_slots"'));
    assert.ok(block.includes("{...}"), "age w sub_slots powinien być zwinięty");
  });

  it("nie przecieka kluczem x-render — to adnotacja renderera, nie treść", () => {
    assert.ok(!block.includes("x-render"));
  });

  it("trafia do OBU promptów ekstrakcji, także do plakatowego", () => {
    assert.ok(extractionSystem("2026-07-28").includes(block), "brak bloku w prompcie tekstowym");
    assert.ok(POSTER_SYSTEM.includes(block), "brak bloku w prompcie plakatowym");
  });

  it("konkretna data 'dziś' zostaje w prozie promptu, bo schemat jej nie zna", () => {
    assert.ok(extractionSystem("2026-07-28").includes("2026-07-28"));
  });
});

describe("schemat na drucie (structured outputs, tryb strict)", () => {
  const wire = toWireSchema(ExtractionSchema);
  const nodes = walk(wire);

  it("nie zawiera x-render — to nasza prywatna adnotacja", () => {
    assert.equal(JSON.stringify(wire).includes("x-render"), false);
  });

  it("każdy obiekt jest zamknięty na dodatkowe pola", () => {
    for (const node of nodes.filter((n) => n["type"] === "object")) {
      assert.equal(node["additionalProperties"], false,
        `obiekt bez additionalProperties:false: ${JSON.stringify(Object.keys(node["properties"] ?? {}))}`);
    }
  });

  it('każde pole jest wymagane — „brak" wyrażamy nullem, nie pominięciem klucza', () => {
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
   * Limit dostawcy, nie nasza konwencja. Anthropic kompiluje strict schema i odbija go
   * błędem 400 („too many parameters with union types … limit: 16"), a wyjdzie to dopiero
   * na płatnym wywołaniu — czyli na porannym cronie, nie tutaj. Stąd twardy test.
   *
   * Dodanie JEDNEGO nullowalnego pola potrafi kosztować cztery: pole liczy się w każdym
   * miejscu, w którym jego podschemat zostanie rozwinięty (`age` w sub_slots kosztował
   * drugie tyle, co `age` na wierzchu). Jeśli ten test zapłonie — patrz `orEmpty`
   * w types/event-schema.ts, czyli tekstowe pola z "" zamiast null.
   */
  it("mieści się w limicie 16 pól unijnych (twardy limit Anthropic)", () => {
    const count = countUnionParams(wire);
    assert.ok(count <= 16, `${count} pól unijnych, limit to 16 — schemat zostanie odbity z 400`);
  });

  it("używa wyłącznie formatów z listy dopuszczonych", () => {
    const allowed = new Set(["date-time", "time", "date", "duration", "email", "hostname",
      "uri", "ipv4", "ipv6", "uuid"]);
    for (const node of nodes) {
      const format = node["format"];
      if (typeof format === "string") assert.ok(allowed.has(format), `nieobsługiwany format "${format}"`);
    }
  });
});
