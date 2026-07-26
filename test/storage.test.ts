/**
 * applyRetention to jedyna NOWA logika w refaktorze — reszta to przenosiny. Zastępuje
 * trzy osobne implementacje przycinania (runs.json, discover-runs.json, costs.json),
 * więc musi odtwarzać każdą z nich co do sztuki. Błąd tutaj kasuje historię
 * albo pozwala plikom puchnąć w publicznym repo.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { applyRetention } from "../src/storage/index.js";
import type { Retention } from "../src/storage/index.js";

interface Rec { at: string; day?: string; run?: string; tag?: string }

const rec = (at: string, over: Partial<Rec> = {}): Rec => ({ at, ...over });
const ats = (rs: Rec[]): string[] => rs.map((r) => r.at);

const base: Retention<Rec> = { at: (r) => r.at };

describe("applyRetention — sortowanie", () => {
  it("porządkuje chronologicznie niezależnie od kolejności podania", () => {
    const out = applyRetention(
      [rec("2026-07-03"), rec("2026-07-01"), rec("2026-07-02")],
      base,
    );
    assert.deepEqual(ats(out), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  });
});

describe("applyRetention — polityka runs.json (7 dni, min 2, max 30)", () => {
  const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const runs: Retention<Rec> = {
    at: (r) => r.at,
    cutoff: () => new Date(Date.now() - 7 * 86_400_000).toISOString(),
    minKeep: 2,
    maxKeep: 30,
  };

  it("wyrzuca starsze niż 7 dni", () => {
    const out = applyRetention([rec(iso(10)), rec(iso(8)), rec(iso(3)), rec(iso(1))], runs);
    assert.equal(out.length, 2);
  });

  it("minKeep wygrywa z wiekiem — po przerwie w cronie zostaje punkt odniesienia", () => {
    const out = applyRetention([rec(iso(40)), rec(iso(30)), rec(iso(20))], runs);
    assert.equal(out.length, 2, "wszystko za stare, ale minKeep=2");
    assert.deepEqual(ats(out), [iso(30), iso(20)], "zostają dwa NAJNOWSZE, nie dwa pierwsze z brzegu");
  });

  it("maxKeep tnie od najstarszych", () => {
    const many = Array.from({ length: 45 }, (_, i) => rec(iso(6 - i / 100)));
    const out = applyRetention(many, runs);
    assert.equal(out.length, 30);
  });
});

describe("applyRetention — polityka discover-runs.json (24 sztuki, szczegóły w 4 najnowszych)", () => {
  const disc: Retention<Rec> = {
    at: (r) => r.at,
    maxKeep: 24,
    slim: { keepDetailed: 4, slim: (r) => ({ ...r, tag: "slim" }) },
  };

  it("odchudza wszystkie poza czterema najnowszymi", () => {
    const rs = Array.from({ length: 10 }, (_, i) => rec(`2026-07-${String(i + 1).padStart(2, "0")}`));
    const out = applyRetention(rs, disc);
    assert.deepEqual(out.map((r) => r.tag), [
      "slim", "slim", "slim", "slim", "slim", "slim", undefined, undefined, undefined, undefined,
    ]);
  });

  it("przy mniej niż keepDetailed nic nie odchudza", () => {
    const out = applyRetention([rec("2026-07-01"), rec("2026-07-02")], disc);
    assert.deepEqual(out.map((r) => r.tag), [undefined, undefined]);
  });

  it("nie gubi rekordów przy limicie", () => {
    const rs = Array.from({ length: 30 }, (_, i) => rec(`2026-07-${String(i + 1).padStart(2, "0")}`));
    assert.equal(applyRetention(rs, disc).length, 24);
  });
});

describe("applyRetention — polityka costs.json (granica dobowa)", () => {
  const costs: Retention<Rec> = {
    at: (r) => r.at,
    ageKey: (r) => r.day ?? r.at,
    cutoff: () => "2026-05-01",
    key: (r) => r.run ?? r.at,
  };

  it("przycina po dacie dziennej, a sortuje po znaczniku zapisu", () => {
    const out = applyRetention([
      rec("2026-04-30T23:00:00Z", { day: "2026-04-30" }),
      rec("2026-05-01T04:00:00Z", { day: "2026-05-01" }),
      rec("2026-06-01T04:00:00Z", { day: "2026-06-01" }),
    ], costs);
    assert.deepEqual(out.map((r) => r.day), ["2026-05-01", "2026-06-01"]);
  });

  it("dzień równy granicy zostaje — inaczej gubimy najstarszą dobę wykresu", () => {
    const out = applyRetention([rec("2026-05-01T00:00:00Z", { day: "2026-05-01" })], costs);
    assert.equal(out.length, 1);
  });
});

describe("applyRetention — brak polityki", () => {
  it("bez cutoff/maxKeep/slim przepuszcza wszystko", () => {
    const rs = [rec("2020-01-01"), rec("2030-01-01")];
    assert.deepEqual(ats(applyRetention(rs, base)), ["2020-01-01", "2030-01-01"]);
  });

  it("nie mutuje wejścia", () => {
    const rs = [rec("2026-07-03"), rec("2026-07-01")];
    applyRetention(rs, base);
    assert.deepEqual(ats(rs), ["2026-07-03", "2026-07-01"]);
  });
});
