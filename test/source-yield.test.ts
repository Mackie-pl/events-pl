/**
 * Rachunek plonu marginalnego. Testujemy go, bo jego wynik jest REKOMENDACJĄ USUNIĘCIA:
 * pomyłka w liczeniu wyłączności kasuje z rejestru źródło, które jako jedyne coś dawało,
 * a błąd w drugą stronę zostawia nadmiar, którego cały ten raport ma szukać.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildYield } from "../src/reporting/source-yield.js";
import type { CostRates, EventRef, RunReport, SourceRun } from "../src/types/index.js";

const RATES: CostRates = {
  bdPerRecord: 0.001, searchPerQuery: 0, storagePerGbMonth: 0, scrapePerFetch: 0, monthlyBudgetUsd: 15,
};

const ev = (title: string, date = "2026-08-10"): EventRef => ({ title, date, url: `https://x/${title}` });

function src(id: string, produced: EventRef[], extra: Partial<SourceRun> = {}): SourceRun {
  return {
    id, name: id, town: "Luboń", url: `https://${id}`, fetch: "plain", status: "ok",
    events: produced.length,
    // brak pola, a nie `undefined` — tak samo jak zapisuje daily; z exactOptionalPropertyTypes
    // to nie jest to samo, a różnica jest dokładnie tym, co odróżnia stary format od pustego plonu
    ...(produced.length ? { produced } : {}),
    followups: [], geo: { hits: 0, misses: 0 },
    llm: { calls: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 },
    ms: 1, ...extra,
  };
}

function run(startedAt: string, sources: SourceRun[]): RunReport {
  const events = sources.reduce((n, s) => n + s.events, 0);
  return {
    stage: "daily", startedAt, finishedAt: startedAt, durationMs: 1,
    sources,
    totals: {
      sources: sources.length, ok: sources.length, unchanged: 0, errors: 0, skippedFb: 0,
      skippedDead: 0, skippedInactive: 0, empty: 0, events, followupsTried: 0,
      geoHits: 0, geoMisses: 0, droppedInvalid: 0, redactedPhones: 0, redactedEmails: 0,
      calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    },
  };
}

describe("buildYield — wyłączność", () => {
  it("wydarzenie u dwóch źródeł nie jest wyłączne u żadnego", () => {
    const r = buildYield([run("2026-08-01", [
      src("a", [ev("Koncert"), ev("Tylko A")]),
      src("b", [ev("Koncert")]),
    ])], RATES);
    const a = r.sources.find((s) => s.id === "a")!;
    const b = r.sources.find((s) => s.id === "b")!;
    assert.equal(a.exclusive, 1, "A ma wyłącznie „Tylko A”");
    assert.equal(a.shared, 1);
    assert.equal(b.exclusive, 0, "B nie ma nic swojego");
    assert.equal(r.distinctEvents, 2);
  });

  it("to samo wydarzenie w kolejnych przebiegach liczy się raz", () => {
    const r = buildYield([
      run("2026-08-01", [src("a", [ev("Koncert")])]),
      run("2026-08-02", [src("a", [ev("Koncert")])]),
    ], RATES);
    const a = r.sources[0]!;
    assert.equal(a.produced, 2, "surowa liczba rekordów");
    assert.equal(a.distinct, 1, "ale to jedno wydarzenie");
    assert.equal(a.runs, 2);
  });

  it("ta sama nazwa w innym dniu to inne wydarzenie", () => {
    const r = buildYield([run("2026-08-01", [
      src("a", [ev("Koncert", "2026-08-10"), ev("Koncert", "2026-08-17")]),
    ])], RATES);
    assert.equal(r.sources[0]?.distinct, 2);
  });
});

describe("buildYield — symulacja zdejmowania", () => {
  it("z dwóch identycznych źródeł zdejmuje DROŻSZE i tylko jedno", () => {
    const both = [ev("Koncert"), ev("Piknik")];
    const r = buildYield([run("2026-08-01", [
      src("tani", both),
      src("drogi", both, { llm: { calls: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.5 } }),
    ])], RATES);
    const drogi = r.steps.find((s) => s.id === "drogi")!;
    const tani = r.steps.find((s) => s.id === "tani")!;
    assert.equal(drogi.dropped, true, "droższy schodzi pierwszy");
    assert.equal(drogi.reason, "redundant");
    assert.equal(tani.dropped, false, "tańszy zostaje JEDYNYM dostawcą i musi zostać");
    assert.equal(tani.wouldLose, 2);
    assert.equal(r.savedUsd, 0.5);
  });

  it("źródło bez ani jednego wydarzenia to `barren`, nie `redundant`", () => {
    const r = buildYield([run("2026-08-01", [
      src("zywe", [ev("Koncert")]),
      src("puste", [], { status: "empty" }),
    ])], RATES);
    const puste = r.steps.find((s) => s.id === "puste")!;
    assert.equal(puste.dropped, true);
    assert.equal(puste.reason, "barren");
    assert.equal(puste.status, "empty");
  });

  it("koszt Bright Data wchodzi do rachunku i decyduje o kolejności", () => {
    const both = [ev("Koncert")];
    const r = buildYield([run("2026-08-01", [
      src("html", both),
      src("fbgrupa", both, {
        llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
        bd: { triggers: 1, inputs: 1, polls: 1, records: 500, errors: 0, snapshots: [] },
      }),
    ])], RATES);
    const fb = r.sources.find((s) => s.id === "fbgrupa")!;
    assert.equal(fb.costUsd, 0.5, "500 rekordów × $0.001");
    assert.equal(r.steps[0]?.id, "fbgrupa", "najdroższe idzie pierwsze mimo zerowego LLM");
    assert.equal(r.steps[0]?.dropped, true);
  });
});

describe("buildYield — okno", () => {
  it("pomija przebiegi sprzed śledzenia przypisań, zamiast liczyć je jako jałowe", () => {
    const stary = run("2026-07-26", [src("a", [])]);
    stary.totals.events = 40; // były wydarzenia, ale bez `produced` — stary format
    const r = buildYield([stary, run("2026-08-01", [src("a", [ev("Koncert")])])], RATES);
    assert.deepEqual(r.skippedRuns, ["2026-07-26"]);
    assert.equal(r.runs, 1);
    assert.equal(r.sources[0]?.exclusive, 1);
  });

  it("przebieg, w którym faktycznie nic nie spłonęło, WCHODZI do okna", () => {
    const pusty = run("2026-08-01", [src("a", [], { status: "empty" })]);
    assert.equal(pusty.totals.events, 0);
    const r = buildYield([pusty], RATES);
    assert.equal(r.runs, 1);
    assert.deepEqual(r.skippedRuns, []);
  });

  it("bez danych nie wywraca się i nie zmyśla wyniku", () => {
    const r = buildYield([], RATES);
    assert.equal(r.runs, 0);
    assert.equal(r.distinctEvents, 0);
    assert.deepEqual(r.sources, []);
    assert.equal(r.savedUsd, 0);
  });
});
