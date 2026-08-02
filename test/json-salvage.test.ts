/**
 * Odzysk z uciętej odpowiedzi modelu.
 *
 * Test istnieje, bo koszt regresji jest asymetryczny: przy ucięciu na `max_tokens` zwykły
 * `JSON.parse` kasuje kilkadziesiąt POPRAWNYCH propozycji razem z jedną niedokończoną,
 * po opłaconym wywołaniu (Poznań 2026-08-01: $0.093 za zero źródeł).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { salvageArray } from "../src/shared/json-salvage.js";

const src = (id: string, extra = ""): string =>
  `{"id":"${id}","name":"Dom Kultury ${id}","url":"https://${id}.pl"${extra}}`;

describe("salvageArray", () => {
  it("odzyskuje kompletne rekordy z tablicy uciętej w środku obiektu", () => {
    const cut = `{"sources":[${src("a")},${src("b")},{"id":"c","name":"Nie`;
    const out = salvageArray(cut, "sources") as Array<{ id: string }>;
    assert.deepEqual(out.map((s) => s.id), ["a", "b"]);
  });

  it("czyta kompletny dokument tak samo jak JSON.parse", () => {
    const whole = `{"sources":[${src("a")},${src("b")}]}`;
    assert.deepEqual(
      salvageArray(whole, "sources"),
      (JSON.parse(whole) as { sources: unknown[] }).sources,
    );
  });

  it("nie gubi obiektów zagnieżdżonych ani nawiasów w tekście", () => {
    // klamra w wartości tekstowej i zagnieżdżony obiekt to jedyne dwa sposoby, żeby
    // naiwne liczenie nawiasów rozjechało się o jeden i zwróciło śmieci
    const tricky = `{"sources":[${src("a", ',"why":"gmina {Poznań} — } w tekście","meta":{"n":1}')},${src("b")}]}`;
    const out = salvageArray(tricky, "sources") as Array<{ id: string; why?: string }>;
    assert.deepEqual(out.map((s) => s.id), ["a", "b"]);
    assert.equal(out[0]?.why, "gmina {Poznań} — } w tekście");
  });

  it("radzi sobie z ucięciem w środku literału tekstowego", () => {
    const cut = `{"sources":[${src("a")},{"id":"b","why":"ucięte w pół zda`;
    assert.deepEqual((salvageArray(cut, "sources") as Array<{ id: string }>).map((s) => s.id), ["a"]);
  });

  it("zwraca pustą listę, gdy nie ma czego odzyskać", () => {
    assert.deepEqual(salvageArray("", "sources"), []);
    assert.deepEqual(salvageArray("zupełnie nie JSON", "sources"), []);
    assert.deepEqual(salvageArray('{"sources":[{"id":"a"', "sources"), []);
    assert.deepEqual(salvageArray('{"sources":[]}', "sources"), []);
  });

  it("zatrzymuje się na końcu tablicy i nie wchodzi w dalsze pola", () => {
    const doc = `{"sources":[${src("a")}],"debug":{"id":"NIE-TO"}}`;
    assert.deepEqual((salvageArray(doc, "sources") as Array<{ id: string }>).map((s) => s.id), ["a"]);
  });
});
