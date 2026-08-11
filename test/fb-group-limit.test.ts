/**
 * Regulator limitu steruje wydatkiem u dostawcy rozliczającego się per-rekord — czyli jest
 * dokładnie tym kształtem kodu, który 2026-08-10 kosztował $8. Dwie własności muszą trzymać
 * niezależnie od danych wejściowych: nigdy powyżej sufitu, i nigdy nie zjeżdża tak nisko,
 * żeby przestać pokrywać przerwę między przebiegami.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { fbGroupLimit, noteFbGroupRate } from "../src/pipeline/extract/fb-group-limit.js";
import type { FbGroupStats, PipelineState } from "../src/types/index.js";

const state = (): PipelineState => ({ hashes: {}, geo: {} });

const stats = (over: Partial<FbGroupStats> = {}): FbGroupStats => ({
  records: 50, posts: 50, errorRows: 0, limit: 50, atLimit: true,
  newest: "2026-08-12", oldest: "2026-08-11", spanDays: 1.5, postsPerDay: 33, ...over,
});

afterEach(() => {
  delete process.env["FB_GROUP_LIMIT_MAX"];
  delete process.env["FB_GROUP_LIMIT_MIN"];
  delete process.env["FB_GROUP_LIMIT_MARGIN"];
});

describe("fbGroupLimit — punkt wyjścia", () => {
  it("bez pomiaru bierze sufit, czyli dotychczasowe zachowanie", () => {
    assert.equal(fbGroupLimit("g", state(), "2026-08-12"), 50);
  });

  it("dłuższa przerwa wymaga proporcjonalnie więcej rekordów", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-08-10", next: 12, postsPerDay: 10, spanDays: 1.2 } };
    assert.equal(fbGroupLimit("g", s, "2026-08-11"), 12, "jedna doba przerwy — tyle, ile zapisano");
    assert.equal(fbGroupLimit("g", s, "2026-08-13"), 36, "trzy doby — trzy razy tyle");
  });

  it("nigdy powyżej sufitu, choćby przerwa trwała miesiąc", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-07-01", next: 40, postsPerDay: 33, spanDays: 1.2 } };
    assert.equal(fbGroupLimit("g", s, "2026-08-12"), 50);
  });
});

describe("noteFbGroupRate — regulator pokrycia", () => {
  it("limit niewyczerpany → schodzimy do tego, co realnie leży, plus zapas", () => {
    const s = state();
    // 6 postów z limitu 50: grupa nie ma więcej, więc 50 to marnotrawstwo
    noteFbGroupRate("g", stats({ records: 6, posts: 6, atLimit: false, spanDays: 5 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 10, "6 × 1.2 = 7.2, podniesione do podłogi 10");
  });

  it("okno pokrywa przerwę z zapasem → schodzimy poniżej sufitu", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-08-11", next: 50, postsPerDay: 33, spanDays: 4 } };
    // 50 postów rozłożone na 4 doby przy dobowej przerwie: starczy ~15 na dobę z zapasem
    noteFbGroupRate("g", stats({ spanDays: 4 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 15);
  });

  it("okno KRÓTSZE niż przerwa → podnosimy, bo treść ucieka", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-08-11", next: 20, postsPerDay: 40, spanDays: 0.5 } };
    noteFbGroupRate("g", stats({ spanDays: 0.5, limit: 20 }), s, "2026-08-12");
    const next = s.fbGroupRate?.["g"]?.next ?? 0;
    assert.ok(next > 20, `powinno rosnąć, jest ${next}`);
    assert.ok(next <= 50, "ale nie ponad sufit");
  });

  it("sufit obowiązuje także przy rosnącym regulatorze", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-08-11", next: 50, postsPerDay: 200, spanDays: 0.1 } };
    noteFbGroupRate("g", stats({ spanDays: 0.1 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 50, "regulator nie może podnieść wydatku ponad dzisiejszy");
  });

  it("same wiersze błędu nie ruszają regulatora — od tego jest fb-group-blocked", () => {
    const s = state();
    noteFbGroupRate("g", stats({ records: 1, posts: 0, errorRows: 1, atLimit: false }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"], undefined);
  });

  it("podłoga trzyma nawet przy grupie, która nic nie publikuje", () => {
    const s = state();
    noteFbGroupRate("g", stats({ records: 1, posts: 1, atLimit: false, spanDays: 0 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 10);
  });
});
