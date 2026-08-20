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
  records: 50, posts: 50, errorRows: 0, sharedOnly: 0, imageOnly: 0, limit: 50, atLimit: true,
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
    // 6 rekordów z limitu 50: grupa nie ma więcej, więc 50 to marnotrawstwo
    noteFbGroupRate("g", stats({ records: 6, posts: 6, atLimit: false, spanDays: 5 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 8, "6 × 1.2 = 7.2");
  });

  it("okno pokrywa przerwę z zapasem → schodzimy poniżej sufitu", () => {
    const s = state();
    s.fbGroupRate = { g: { at: "2026-08-11", next: 50, postsPerDay: 33, spanDays: 4 } };
    // 50 rekordów rozłożone na 4 doby przy dobowej przerwie: starczy ~15 na dobę z zapasem
    noteFbGroupRate("g", stats({ spanDays: 4 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 15);
  });

  it("liczy w rekordach, nie w postach — rekord bez treści też jest płatny", () => {
    const s = state();
    // 11 postów z 50 płatnych rekordów (Luboń, 2026-08-12): potrzeba liczona w postach
    // dałaby limit 4× za niski, bo za pozostałe 39 rekordów i tak zapłacimy
    noteFbGroupRate("g", stats({ records: 50, posts: 11, errorRows: 39, spanDays: 4 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 15, "50/4 × 1.2, a nie 11/4 × 1.2");
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
    // bez podłogi limit zjechałby do 1 i zamroziłby regulator: tempa nie da się zmierzyć
    // na pobraniu, które nie ma z czego policzyć okna
    noteFbGroupRate("g", stats({ records: 1, posts: 1, atLimit: false, spanDays: 0 }), s, "2026-08-12");
    assert.equal(s.fbGroupRate?.["g"]?.next, 5);
  });
});
