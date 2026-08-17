/**
 * Regulator budżetu decyduje, co w ogóle pobieramy, więc jego błąd kosztuje albo pieniądze,
 * albo gminę wyciętą z serwisu. Testy pilnują WŁASNOŚCI, dla których go napisaliśmy —
 * nie kolejności wierszy.
 *
 * Najważniejsza z nich i cały powód zmiany: TANIE ŹRÓDŁO MA WYPYCHAĆ DROŻSZE. Przy progu
 * cenowym (`FB_MAX_USD_PER_EVENT` sprzed 2026-08-17) każde nowe znalezisko tylko dokładało
 * do rachunku, bo próg pytał „czy to źródło jest tanie", a płacimy za sumę. Pomiar
 * 2026-08-17: 15 z 24 grup przechodziło próg $0.02 i dawało $17.3/mies. przy budżecie $15.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BudgetInput } from "../src/pipeline/extract/fb-budget.js";
import { fbDailyBudget, marginalPrice, rankByBudget } from "../src/pipeline/extract/fb-budget.js";

const src = (over: Partial<BudgetInput> & { id: string }): BudgetInput => ({
  town: "Luboń", fetch: "fb_group", fetchedRuns: 7, novel: 10,
  usdPerFetch: 0.1, usdPerNovel: 0.01, ...over,
});

/** Źródło bez ceny: `novel === 0`, więc `usdPerNovel` NIE ISTNIEJE (nie jest `undefined`). */
const priceless = (id: string): BudgetInput => {
  const { usdPerNovel: _drop, ...rest } = src({ id, novel: 0 });
  return rest;
};

const OPTS = {
  dailyUsd: 0.25, probationShare: 0, minRuns: 5, ceilingUsdPerNovel: null,
};

const verdictOf = (rows: ReturnType<typeof rankByBudget>, id: string): string | undefined =>
  rows.find((r) => r.id === id)?.verdict;

describe("rankByBudget — kolejka wartości", () => {
  it("przyjmuje od najtańszego, aż budżet się skończy", () => {
    const r = rankByBudget([
      src({ id: "drogie", usdPerNovel: 0.03 }),
      src({ id: "tanie", usdPerNovel: 0.001 }),
      src({ id: "srednie", usdPerNovel: 0.01 }),
    ], OPTS);
    assert.equal(verdictOf(r, "tanie"), "in-budget");
    assert.equal(verdictOf(r, "srednie"), "in-budget");
    assert.equal(verdictOf(r, "drogie"), "over-budget", "trzecie już się nie mieści w $0.25");
  });

  it("TANIE ŹRÓDŁO WYPYCHA DROŻSZE — to jest cała różnica wobec progu cenowego", () => {
    const before = rankByBudget([
      src({ id: "a", usdPerNovel: 0.01 }),
      src({ id: "b", usdPerNovel: 0.02 }),
    ], OPTS);
    assert.equal(verdictOf(before, "b"), "in-budget");

    // znajdujemy źródło tańsze od obu — rachunek NIE rośnie, wypada najdroższe
    const after = rankByBudget([
      src({ id: "a", usdPerNovel: 0.01 }),
      src({ id: "b", usdPerNovel: 0.02 }),
      src({ id: "nowe-tanie", usdPerNovel: 0.0001 }),
    ], OPTS);
    assert.equal(verdictOf(after, "nowe-tanie"), "in-budget");
    assert.equal(verdictOf(after, "b"), "over-budget");
    const spend = after.filter((x) => x.verdict === "in-budget")
      .reduce((n, x) => n + x.usdPerFetch, 0);
    assert.ok(spend <= OPTS.dailyUsd, "suma przyjętych nigdy nie przekracza budżetu");
  });

  it("budżet zero nie przyjmuje niczego — regulator umie wydatek tylko zmniejszać", () => {
    const r = rankByBudget([src({ id: "a" }), src({ id: "b" })], { ...OPTS, dailyUsd: 0 });
    assert.equal(r.filter((x) => x.verdict === "in-budget").length, 0);
  });

  it("źródło bez nowych wydarzeń ląduje na końcu kolejki, nie na początku", () => {
    // brak `usdPerNovel` to najgorsza możliwa cena, a nie „za darmo"
    const r = rankByBudget([
      priceless("jalowe"),
      src({ id: "zwykle", usdPerNovel: 0.02 }),
    ], { ...OPTS, dailyUsd: 0.15 });
    assert.equal(verdictOf(r, "zwykle"), "in-budget");
    assert.equal(verdictOf(r, "jalowe"), "over-budget");
  });

  it("grupy i fanpage'e stoją w JEDNEJ kolejce — decyduje cena, nie sposób pobrania", () => {
    const r = rankByBudget([
      src({ id: "grupa", fetch: "fb_group", usdPerNovel: 0.02 }),
      src({ id: "fanpage", fetch: "fb", usdPerNovel: 0.0006 }),
    ], { ...OPTS, dailyUsd: 0.15 });
    assert.equal(verdictOf(r, "fanpage"), "in-budget");
    assert.equal(verdictOf(r, "grupa"), "over-budget");
  });
});

describe("rankByBudget — pas pomiarowy", () => {
  it("niezmierzone nie wchodzą do kolejki wartości, tylko na pas", () => {
    const r = rankByBudget([
      src({ id: "znane", usdPerNovel: 0.01 }),
      src({ id: "nowe", fetchedRuns: 0, novel: 0 }),
    ], { ...OPTS, probationShare: 0.5 });
    assert.equal(verdictOf(r, "znane"), "in-budget");
    assert.equal(verdictOf(r, "nowe"), "probation");
    assert.equal(r.find((x) => x.id === "nowe")?.rank, null, "niezmierzone nie mają pozycji");
  });

  it("pas jest ograniczony — nadmiar czeka na kolejny przebieg", () => {
    const r = rankByBudget([
      src({ id: "n1", fetchedRuns: 0, usdPerFetch: 0.1 }),
      src({ id: "n2", fetchedRuns: 0, usdPerFetch: 0.1 }),
      src({ id: "n3", fetchedRuns: 0, usdPerFetch: 0.1 }),
    ], { ...OPTS, dailyUsd: 0.4, probationShare: 0.5 });
    assert.equal(r.filter((x) => x.verdict === "probation").length, 2, "$0.20 pasa = dwa pobrania");
    assert.equal(r.filter((x) => x.verdict === "waiting").length, 1);
  });

  it("pas bierze NAJRZADZIEJ pobierane najpierw — inaczej jedno źródło zajęłoby go na stałe", () => {
    const r = rankByBudget([
      src({ id: "juz-probowane", fetchedRuns: 3 }),
      src({ id: "nigdy", fetchedRuns: 0 }),
    ], { ...OPTS, dailyUsd: 0.2, probationShare: 0.5 });
    assert.equal(verdictOf(r, "nigdy"), "probation");
    assert.equal(verdictOf(r, "juz-probowane"), "waiting");
  });

  it("FB_PROBATION_SHARE=0 zamyka kanał na nowe źródła", () => {
    const r = rankByBudget([src({ id: "nowe", fetchedRuns: 0 })], { ...OPTS, probationShare: 0 });
    assert.equal(verdictOf(r, "nowe"), "waiting");
  });
});

describe("rankByBudget — twardy sufit", () => {
  it("ponad sufitem wypada, choćby budżet miał miejsce", () => {
    const r = rankByBudget([src({ id: "drogie", usdPerNovel: 0.5 })], {
      ...OPTS, dailyUsd: 99, ceilingUsdPerNovel: 0.02,
    });
    assert.equal(verdictOf(r, "drogie"), "over-ceiling");
  });

  it("źródło ponad sufitem NIE zjada budżetu tańszym", () => {
    const r = rankByBudget([
      src({ id: "ponad-sufitem", usdPerNovel: 0.5, usdPerFetch: 0.2 }),
      src({ id: "tanie", usdPerNovel: 0.001, usdPerFetch: 0.2 }),
    ], { ...OPTS, dailyUsd: 0.25, ceilingUsdPerNovel: 0.02 });
    assert.equal(verdictOf(r, "tanie"), "in-budget",
      "gdyby drogie zajmowało miejsce w sumie, tanie wypadłoby bez powodu");
  });
});

describe("marginalPrice — próg jako WYNIK, nie pokrętło", () => {
  it("to cena ostatniego przyjętego źródła", () => {
    const r = rankByBudget([
      src({ id: "a", usdPerNovel: 0.001 }),
      src({ id: "b", usdPerNovel: 0.005 }),
      src({ id: "c", usdPerNovel: 0.03 }),
    ], OPTS);
    assert.equal(marginalPrice(r), 0.005);
  });

  it("pusta kolejka nie ma ceny brzegowej", () => {
    assert.equal(marginalPrice(rankByBudget([], OPTS)), null);
  });
});

describe("fbDailyBudget", () => {
  it("oddaje kanałowi FB to, czego nie zjadła reszta potoku", () => {
    // $15/mies. = $0.50/dobę; ekstrakcja bierze $0.04 → na FB zostaje $0.46
    assert.equal(Number(fbDailyBudget(15, 0.04).toFixed(4)), 0.46);
  });

  it("potanienie modelu samo powiększa budżet FB — nikt tego nie przepisuje", () => {
    const przed = fbDailyBudget(15, 0.75); // ekstrakcja sprzed zmiany modelu
    const po = fbDailyBudget(15, 0.04);
    assert.ok(po > przed);
  });

  it("gdy reszta potoku przekracza budżet, FB dostaje zero, a nie liczbę ujemną", () => {
    assert.equal(fbDailyBudget(15, 2), 0);
  });
});
