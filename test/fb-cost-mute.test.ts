/**
 * Regulator budżetu kasuje źródło z przebiegu, więc jego błędy są kosztowne w obie strony:
 * za luźny płaci za nic, za ciasny wycina gminę z serwisu i nikt tego nie zauważy, bo
 * „brak wydarzeń w Puszczykowie" wygląda dokładnie tak samo jak „w Puszczykowie nic się nie dzieje".
 *
 * Samą kolejkę wartości sprawdza `fb-budget.test.ts`. Tutaj chodzi o to, co regulator
 * ZAPISUJE — wyciszenia, ich wygasanie i podłogę obsady gminy, czyli o przypadki,
 * w których ma NIE zadziałać.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { applyFbMutes, mutedSkip } from "../src/pipeline/extract/fb-cost-mute.js";
import type { SourceYield } from "../src/reporting/source-yield.js";
import type { PipelineState, Source } from "../src/types/index.js";

const state = (): PipelineState => ({ hashes: {}, geo: {} });

/**
 * Atrapa kosztuje $0.05 za pobranie (0.35 w 7 pobraniach) — rząd wielkości realnej grupy.
 * Budżety niżej są dobrane WZGLĘDEM tej kwoty, więc zmiana `costUsd` psuje oba naraz.
 */
const PER_FETCH = 0.05;

/** Mieści dokładnie JEDNO zmierzone źródło: 85% z $0.1 to $0.085, drugie by nie weszło. */
const BUDGET = 0.1;

/** Szerszy: pas pomiarowy (domyślnie 15%) mieści jedno pobranie, czyli $0.075 ≥ $0.05. */
const BUDGET_WIDE = 0.5;

const group: Source = {
  id: "g", name: "Grupa", type: "fb_group", url: "https://www.facebook.com/groups/1",
  town: "Luboń", fetch: "fb_group", verified: true,
};

/** Źródło FB o zadanym rachunku; domyślnie z zapasem pobrań ponad minimum. */
const fb = (over: Partial<SourceYield> = {}): SourceYield => ({
  id: "g", name: "Grupa", town: "Luboń", channel: "fb", fetch: "fb_group",
  runs: 7, fetchedRuns: 7, produced: 20, distinct: 20, exclusive: 4, shared: 16,
  novel: 4, usdPerNovel: 0.25, llmUsd: 0.1, bdRecords: 600, costUsd: PER_FETCH * 7,
  status: "ok", overlaps: [], ...over,
});

/** Źródło pobrane `n` razy, ale wciąż po tej samej cenie za pobranie. */
const fetchedTimes = (n: number, over: Partial<SourceYield> = {}): SourceYield =>
  fb({ fetchedRuns: n, costUsd: PER_FETCH * n, ...over });

/**
 * Pola NIEOBECNE, a nie ustawione na `undefined` — projekt ma `exactOptionalPropertyTypes`,
 * a różnica jest tu merytoryczna: brak `usdPerNovel` znaczy „nie da się policzyć", i to
 * właśnie ten przypadek regulator musi obsłużyć osobno.
 */
function omit(row: SourceYield, ...keys: Array<keyof SourceYield>): SourceYield {
  const copy: Record<string, unknown> = { ...row };
  for (const k of keys) delete copy[k];
  return copy as unknown as SourceYield;
}

const verdictOf = (rows: ReturnType<typeof applyFbMutes>, id: string): string | undefined =>
  rows.find((r) => r.id === id)?.verdict;

afterEach(() => {
  delete process.env["FB_MAX_USD_PER_EVENT"];
  delete process.env["FB_YIELD_MIN_RUNS"];
  delete process.env["FB_MUTE_DAYS"];
  delete process.env["FB_MIN_SOURCES_PER_TOWN"];
  delete process.env["FB_GROUP_BLOCKED_LIMIT"];
  delete process.env["FB_PROBATION_SHARE"];
});

describe("kiedy regulator MA nie zadziałać", () => {
  it("za mało realnych pobrań = pas pomiarowy, nie werdykt negatywny", () => {
    // 4 pobrania przy domyślnym minimum 5 — jeden chudy tydzień to nie dowód
    const s = state();
    const rows = applyFbMutes([fetchedTimes(4, { usdPerNovel: 99 })], s, "2026-08-12", BUDGET_WIDE);
    assert.equal(rows[0]?.verdict, "probation");
    assert.deepEqual(s.fbMuted, {}, "źródło bez wiarygodnej ceny nie ma jak przekroczyć budżetu");
  });

  it("pominięte przebiegi nie liczą się do minimum", () => {
    // źródło było w 7 przebiegach, ale pobrane tylko 2 razy (reszta: skipped-*)
    const rows = applyFbMutes(
      [fetchedTimes(2, { runs: 7, usdPerNovel: 99 })], state(), "2026-08-12", BUDGET_WIDE,
    );
    assert.equal(rows[0]?.verdict, "probation");
  });

  it("źródła spoza FB w ogóle nie wchodzą do rachunku", () => {
    const s = state();
    const web = omit(fb({ id: "strona", channel: "web", fetch: "plain" }), "novel", "usdPerNovel");
    const rows = applyFbMutes([web], s, "2026-08-12", BUDGET);
    assert.deepEqual(rows, []);
    assert.deepEqual(s.fbMuted, {});
  });

  it("zbiorczy wiersz fb-events nie da się wyciszyć, choćby nie dał nic nowego", () => {
    // to nie jest źródło z rejestru, tylko rozwiązywanie linków zebranych ze WSZYSTKICH
    // źródeł — wyciszenie wyłączyłoby wydarzenia FB w całym potoku
    const s = state();
    const rows = applyFbMutes(
      [omit(fb({ id: "fb-events", fetch: "fb_event", novel: 0 }), "usdPerNovel")],
      s, "2026-08-12", 0,
    );
    assert.equal(rows[0]?.verdict, "no-threshold");
    assert.deepEqual(s.fbMuted, {});
  });
});

describe("zero nowych wydarzeń", () => {
  it("to najgorszy stosunek, nie brak danych", () => {
    // wszystko, co dało, ma już któraś ze stron — dzielenie przez zero nie może wyjść na „tanio".
    // Podłoga wyłączona, bo inaczej uratowałaby jedyne źródło gminy i test mierzyłby ją
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const rows = applyFbMutes(
      [omit(fb({ novel: 0 }), "usdPerNovel")], state(), "2026-08-12", BUDGET,
    );
    assert.equal(rows[0]?.verdict, "muted");
  });

  it("nie mieści się w budżecie NAWET gdy zostało w nim miejsce", () => {
    // cena nieskończona: „cokolwiek za zero nowych wydarzeń" jest złym interesem przy
    // każdej kwocie, a sam zachłanny spacer patrzy tylko na sumę
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const rows = applyFbMutes(
      [omit(fb({ novel: 0 }), "usdPerNovel")], state(), "2026-08-12", 99,
    );
    assert.equal(rows[0]?.verdict, "muted");
  });

  it("darmowe źródło bez nowych wydarzeń i tak leci (0/0 to nie jest zero kosztu)", () => {
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const rows = applyFbMutes(
      [omit(fb({ novel: 0, costUsd: 0 }), "usdPerNovel")], state(), "2026-08-12", BUDGET,
    );
    assert.equal(rows[0]?.verdict, "muted");
  });
});

describe("applyFbMutes — zapis i wygasanie", () => {
  /**
   * Tania grupa w tej samej gminie. Bez niej podłoga obsady ratowałaby jedyne źródło Lubonia
   * i te testy sprawdzałyby podłogę zamiast wyciszania.
   */
  const sasiadka = fb({ id: "tania-sasiadka", usdPerNovel: 0.001 });

  it("wycisza czasowo i podaje podstawę werdyktu", () => {
    process.env["FB_MUTE_DAYS"] = "30";
    const s = state();
    const rows = applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "g"), "muted");
    assert.equal(s.fbMuted?.["g"]?.until, "2026-09-11");
    assert.equal(s.fbMuted?.["g"]?.novel, 4, "podstawa zostaje, żeby dało się werdykt sprawdzić");
  });

  it("wyciszenie wygasa samo — bez tego chudy tydzień byłby wyrokiem dożywotnim", () => {
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12", BUDGET);
    assert.ok(mutedSkip(group, s, "2026-09-10"), "dzień przed terminem jeszcze cisza");
    assert.equal(mutedSkip(group, s, "2026-09-11"), null, "w dniu `until` wraca do pomiaru");
  });

  it("potanienie zdejmuje wyciszenie przed terminem", () => {
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12", BUDGET);
    assert.ok(s.fbMuted?.["g"], "najpierw musi być co zdejmować");
    // nazajutrz to ONO jest tańsze — wraca do budżetu, a sąsiadka wypada
    applyFbMutes([fb({ usdPerNovel: 0.0001 }), sasiadka], s, "2026-08-13", BUDGET);
    assert.equal(s.fbMuted?.["g"], undefined);
  });

  it("SZERSZY BUDŻET sam przywraca wyciszone — bez niczyjej decyzji", () => {
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12", BUDGET);
    assert.ok(s.fbMuted?.["g"]);
    // reszta potoku staniała (np. tańszy model) → w budżecie robi się miejsce na oba
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-13", BUDGET_WIDE);
    assert.equal(s.fbMuted?.["g"], undefined);
  });

  it("fanpage podlega regulatorowi tak samo jak grupa — decyduje cena, nie sposób pobrania", () => {
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "fanpage", fetch: "fb", usdPerNovel: 0.25 }),
      fb({ id: "tania-grupa", usdPerNovel: 0.001 }),
    ], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "fanpage"), "muted");
    assert.ok(s.fbMuted?.["fanpage"], "fanpage też zapisuje się w rejestrze wyciszeń");
  });

  it("TANI FANPAGE wypycha drogą grupę, a nie dokłada się do rachunku", () => {
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "droga-tablica", usdPerNovel: 0.0092 }),
      fb({ id: "tani-fanpage", fetch: "fb", usdPerNovel: 0.0006 }),
    ], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "tani-fanpage"), "keep");
    assert.equal(verdictOf(rows, "droga-tablica"), "muted");
  });
});

describe("twardy sufit FB_MAX_USD_PER_EVENT", () => {
  it("wycina ponad sufitem, choćby budżet miał miejsce", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const rows = applyFbMutes([fb({ usdPerNovel: 0.25 })], state(), "2026-08-12", 99);
    assert.equal(rows[0]?.verdict, "over-ceiling");
  });

  it("nieustawiony = decyduje sam budżet", () => {
    const rows = applyFbMutes([fb({ usdPerNovel: 0.25 })], state(), "2026-08-12", 99);
    assert.equal(rows[0]?.verdict, "keep");
  });
});

/**
 * Sama kolejka wartości jest stronnicza geograficznie i to nie przez jakość źródeł, tylko
 * przez arytmetykę: ten sam koszt rekordów dzieli się w gminie wiejskiej przez kilka
 * wydarzeń, a w Poznaniu przez pięćdziesiąt. Bez podłogi budżet zdjąłby najpierw Puszczykowo,
 * Luboń i Dopiewo — czyli dokładnie te gminy, dla których ten serwis powstał.
 */
describe("podłoga obsady gminy", () => {
  it("jedyne źródło w gminie zostaje, choćby było najdroższe", () => {
    const s = state();
    const rows = applyFbMutes(
      [fb({ id: "kocham-puszczykowo", town: "Puszczykowo", usdPerNovel: 0.0908 })],
      s, "2026-08-12", 0,
    );
    assert.equal(verdictOf(rows, "kocham-puszczykowo"), "town-floor");
    assert.deepEqual(s.fbMuted, {}, "nie może zostać zapisane jako wyciszone");
  });

  it("z trzech drogich źródeł w gminie zostaje NAJTAŃSZE, reszta leci", () => {
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "drogie", town: "Puszczykowo", usdPerNovel: 0.09 }),
      fb({ id: "najtansze", town: "Puszczykowo", usdPerNovel: 0.03 }),
      fb({ id: "srednie", town: "Puszczykowo", usdPerNovel: 0.05 }),
    ], s, "2026-08-12", 0);
    assert.equal(verdictOf(rows, "najtansze"), "town-floor");
    assert.equal(verdictOf(rows, "srednie"), "muted");
    assert.equal(verdictOf(rows, "drogie"), "muted");
  });

  it("FANPAGE OBSADZA GMINĘ tak samo jak grupa — inaczej podłoga wymuszałaby płatną tablicę", () => {
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "fanpage-biblioteki", town: "Puszczykowo", fetch: "fb", usdPerNovel: 0.001 }),
      fb({ id: "tablica-ogloszen", town: "Puszczykowo", usdPerNovel: 0.0092 }),
    ], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "fanpage-biblioteki"), "keep");
    assert.equal(verdictOf(rows, "tablica-ogloszen"), "muted",
      "gmina jest obsadzona fanpage'em, więc tablicy nie trzeba ratować");
  });

  it("gmina z tanim źródłem nie ratuje drogiego — podłoga jest już obsadzona", () => {
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "tanie", town: "Poznań", usdPerNovel: 0.002 }),
      fb({ id: "drogie", town: "Poznań", usdPerNovel: 0.09 }),
    ], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "tanie"), "keep");
    assert.equal(verdictOf(rows, "drogie"), "muted");
  });

  it("podłoga liczy się osobno dla każdej gminy", () => {
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "poznan-tanie", town: "Poznań", usdPerNovel: 0.002 }),
      fb({ id: "lubon-drogie", town: "Luboń", usdPerNovel: 0.09 }),
    ], s, "2026-08-12", BUDGET);
    assert.equal(verdictOf(rows, "lubon-drogie"), "town-floor",
      "tanie źródło w Poznaniu nie obsadza Lubonia");
  });

  it("źródło niedostępne nie obsadza gminy — inaczej blokowałoby jedyne działające", () => {
    const s = state();
    s.fbGroupBlocked = { prywatna: { runs: 3, since: "2026-08-01", lastTry: "2026-08-11" } };
    const rows = applyFbMutes([
      fb({ id: "prywatna", town: "Dopiewo", novel: 0, usdPerNovel: 0.5 }),
      fb({ id: "dzialajaca", town: "Dopiewo", usdPerNovel: 0.09 }),
    ], s, "2026-08-12", 0);
    assert.equal(verdictOf(rows, "dzialajaca"), "town-floor");
    assert.equal(verdictOf(rows, "prywatna"), "muted", "niedostępnej nie ratujemy");
  });

  it("podłoga zdejmuje wyciszenie z poprzedniego przebiegu", () => {
    const s = state();
    applyFbMutes([
      fb({ id: "tanie", town: "Mosina", usdPerNovel: 0.002 }),
      fb({ id: "drogie", town: "Mosina", usdPerNovel: 0.09 }),
    ], s, "2026-08-12", BUDGET);
    assert.ok(s.fbMuted?.["drogie"]);
    // nazajutrz tanie źródło wypada z okna — drogie zostaje jedyne i musi wrócić
    applyFbMutes([fb({ id: "drogie", town: "Mosina", usdPerNovel: 0.09 })], s, "2026-08-13", 0);
    assert.equal(s.fbMuted?.["drogie"], undefined);
  });

  it("FB_MIN_SOURCES_PER_TOWN=0 wyłącza podłogę", () => {
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const rows = applyFbMutes(
      [fb({ id: "jedyna", town: "Puszczykowo", usdPerNovel: 0.09 })], state(), "2026-08-12", 0,
    );
    assert.equal(verdictOf(rows, "jedyna"), "muted");
  });

  it("podłoga 2 zostawia dwa najtańsze", () => {
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "2";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "a", town: "Luboń", usdPerNovel: 0.09 }),
      fb({ id: "b", town: "Luboń", usdPerNovel: 0.03 }),
      fb({ id: "c", town: "Luboń", usdPerNovel: 0.05 }),
    ], s, "2026-08-12", 0);
    assert.equal(verdictOf(rows, "b"), "town-floor");
    assert.equal(verdictOf(rows, "c"), "town-floor");
    assert.equal(verdictOf(rows, "a"), "muted");
  });

  it("źródło bez ani jednego nowego wydarzenia też może zostać podłogą", () => {
    // brak `usdPerNovel` sortuje się na koniec, ale gdy nie ma nikogo innego — ratuje je podłoga
    const rows = applyFbMutes(
      [omit(fb({ id: "jedyna", town: "Puszczykowo", novel: 0 }), "usdPerNovel")],
      state(), "2026-08-12", 0,
    );
    assert.equal(verdictOf(rows, "jedyna"), "town-floor");
  });
});
