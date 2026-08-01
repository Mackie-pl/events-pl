/**
 * Rozliczenie rejestru z wynikami discovery.
 *
 * Reguła jest asymetryczna z premedytacją: brak trafienia w wyszukiwarce degraduje, ale nigdy
 * nie zabija, a plon w `runs.json` unieważnia degradację. Testy pilnują właśnie tej asymetrii —
 * bo poprzednia wersja potoku nie miała pojęcia, że źródło przestało być znajdowane, i jedyną
 * drogą do usunięcia czegokolwiek była drabina osiągalności.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { MISS_LIMIT, harvestById, reconcile } from "../src/pipeline/discover/reconcile.js";
import type { RunReport, Source } from "../src/types/index.js";

const RUN = "2026-08-01T03:00:00.000Z";

const source = (over: Partial<Source> = {}): Source => ({
  id: "gok", name: "GOK", type: "culture_center", url: "https://gok.test/",
  town: "Luboń", fetch: "plain", verified: true, ...over,
});

const ctx = (over: Partial<Parameters<typeof reconcile>[1]> = {}) => ({
  run: RUN, towns: ["Luboń"], harvest: new Map<string, number>(), ...over,
});

/** Ile razy trzeba spudłować, żeby degradacja w ogóle wchodziła w grę. */
const atLimit = MISS_LIMIT - 1;

describe("reconcile — naliczanie pudeł", () => {
  it("źródło potwierdzone w tym przebiegu ma wyzerowany licznik", () => {
    const src = source({ lastSeenRun: RUN, missedRuns: 0 });
    const out = reconcile([src], ctx());

    assert.equal(out.missed, 0);
    assert.equal(src.missedRuns, 0);
  });

  it("źródło nieznalezione dostaje pudło, ale nie znika", () => {
    const src = source({ lastSeenRun: "2026-07-01T00:00:00.000Z" });
    const out = reconcile([src], ctx());

    assert.equal(out.missed, 1);
    assert.equal(src.missedRuns, 1);
    assert.equal(src.inactive, undefined, "jedno pudło to za mało — wyszukiwarka nie jest wyrocznią");
  });

  it("dopiero MISS_LIMIT pudeł z rzędu degraduje", () => {
    const src = source({ missedRuns: atLimit });
    const out = reconcile([src], ctx());

    assert.equal(src.missedRuns, MISS_LIMIT);
    assert.equal(src.inactive, true);
    assert.deepEqual(out.deactivated, ["gok"]);
    assert.match(src.notes ?? "", /nieaktywne/);
  });
});

describe("reconcile — plon ma weto", () => {
  it("źródło z wydarzeniami nie zostaje zdegradowane mimo pudeł", () => {
    const src = source({ missedRuns: atLimit });
    const out = reconcile([src], ctx({ harvest: new Map([["gok", 12]]) }));

    assert.equal(src.inactive, undefined, "plon jest twardszym dowodem niż brak trafienia");
    assert.deepEqual(out.deactivated, []);
    assert.equal(src.missedRuns, MISS_LIMIT, "pudło i tak się liczy — tylko nie degraduje");
  });
});

describe("reconcile — kogo w ogóle rozliczamy", () => {
  it("gmina spoza zasięgu przebiegu nie generuje pudeł", () => {
    // nikt tam nie szukał, więc „nie znaleziono" nie niesie żadnej informacji
    const src = source({ town: "Swarzędz", missedRuns: atLimit });
    const out = reconcile([src], ctx({ towns: ["Luboń"] }));

    assert.equal(out.missed, 0);
    assert.equal(src.missedRuns, atLimit);
  });

  it("źródła FB są wyłączone — Google nie indeksuje grup, a verify ich nie dotyka", () => {
    const src = source({ fetch: "fb_group", url: "https://www.facebook.com/groups/lubon", missedRuns: atLimit });
    const out = reconcile([src], ctx());

    assert.equal(out.missed, 0);
    assert.equal(src.inactive, undefined);
  });

  it("źródło już martwe nie jest dodatkowo degradowane", () => {
    const src = source({ dead: true, missedRuns: atLimit });
    const out = reconcile([src], ctx());

    assert.equal(out.missed, 0);
    assert.equal(src.inactive, undefined, "dead i inactive to różne diagnozy, nie warstwy");
  });
});

describe("harvestById", () => {
  it("sumuje wydarzenia jednego źródła po całym oknie runs.json", () => {
    const run = (events: number): RunReport => ({
      stage: "daily", startedAt: "x", finishedAt: "y", durationMs: 1,
      totals: {} as RunReport["totals"],
      sources: [{ id: "gok", events } as RunReport["sources"][number]],
    });

    assert.equal(harvestById([run(3), run(4)]).get("gok"), 7);
  });
});
