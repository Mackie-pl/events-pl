/**
 * Księga kosztów to jedyne miejsce, gdzie wolumen spotyka się ze stawką, a jej wpisy
 * są nieodwracalne (raporty przebiegów wygasają szybciej niż księga). Testujemy reguły,
 * które przy przenoszeniu pliku łatwo zgubić: pomijanie pustych kategorii, zaokrąglanie
 * i wybór TOP-5 najdroższych pozycji.
 *
 * recordCosts()/loadCostEntries() świadomie NIE są tu testowane: COSTS_PATH to stała
 * wskazująca prawdziwy costs.json w repo, więc test nadpisałby produkcyjną księgę.
 * Wejdą do testów dopiero, gdy ścieżka stanie się parametrem (Faza B/D).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { type CostInput, costEntries, costLine, totalUsd } from "../src/cost.js";

const RUN = "2026-07-26T04:00:00.000Z";
const AT = "2026-07-26T04:12:00.000Z";

const input = (over: Partial<CostInput> = {}): CostInput => ({
  category: "llm-extract",
  usd: 0.05,
  estimated: false,
  units: 12,
  unit: "calls",
  ...over,
});

describe("costEntries", () => {
  it("wyprowadza dzień z identyfikatora przebiegu", () => {
    const [e] = costEntries("daily", RUN, [input()], AT);
    assert.equal(e?.day, "2026-07-26");
    assert.equal(e?.at, AT);
    assert.equal(e?.stage, "daily");
    assert.equal(e?.run, RUN);
  });

  it("pomija kategorie bez wolumenu i bez kwoty", () => {
    const out = costEntries("daily", RUN, [
      input({ category: "fb", usd: 0, units: 0 }),
      input({ category: "geo", usd: 0, units: 3 }),
      input({ category: "storage", usd: 0.01, units: 0 }),
    ], AT);
    assert.deepEqual(out.map((e) => e.category), ["geo", "storage"]);
  });

  it("zaokrągla kwoty do 6 miejsc, a wolumen do 3", () => {
    const [e] = costEntries("daily", RUN, [
      input({ usd: 0.123456789, units: 1.23456 }),
    ], AT);
    assert.equal(e?.usd, 0.123457);
    assert.equal(e?.units, 1.235);
  });

  it("zostawia 5 najdroższych driverów, posortowanych malejąco", () => {
    const drivers = [1, 7, 3, 9, 5, 2, 8].map((usd, i) => ({ id: `src-${i}`, usd, units: 1 }));
    const [e] = costEntries("daily", RUN, [input({ drivers })], AT);
    assert.equal(e?.top?.length, 5);
    assert.deepEqual(e?.top?.map((d) => d.usd), [9, 8, 7, 5, 3]);
  });

  it("odfiltrowuje driverów zerowych i pomija pole top, gdy nic nie zostaje", () => {
    const [e] = costEntries("daily", RUN, [
      input({ drivers: [{ id: "a", usd: 0, units: 0 }] }),
    ], AT);
    assert.equal(e?.top, undefined);
  });

  it("pola opcjonalne pojawiają się tylko gdy niezerowe", () => {
    const [bare] = costEntries("daily", RUN, [input()], AT);
    assert.equal(bare?.tokensIn, undefined);
    assert.equal(bare?.tokensOut, undefined);
    assert.equal(bare?.inferred, undefined);

    const [full] = costEntries("daily", RUN, [
      input({ tokensIn: 100, tokensOut: 20, inferred: true }),
    ], AT);
    assert.equal(full?.tokensIn, 100);
    assert.equal(full?.tokensOut, 20);
    assert.equal(full?.inferred, true);
  });
});

describe("costLine", () => {
  it("sumuje i rozbija na kategorie, malejąco; ~ oznacza szacunek", () => {
    const entries = costEntries("daily", RUN, [
      input({ category: "llm-extract", usd: 0.09 }),
      input({ category: "llm-vision", usd: 0.03 }),
      input({ category: "fb", usd: 0.01, estimated: true }),
    ], AT);
    assert.equal(costLine(entries), "$0.1300 (tekst $0.0900 · plakaty $0.0300 · FB $0.0100~)");
  });

  it("pojedyncza kategoria nie dostaje nawiasu", () => {
    const entries = costEntries("daily", RUN, [input({ usd: 0.5 })], AT);
    assert.equal(costLine(entries), "$0.5000");
  });

  it("pusta lista → zero", () => {
    assert.equal(costLine([]), "$0.0000");
    assert.equal(totalUsd([]), 0);
  });
});
