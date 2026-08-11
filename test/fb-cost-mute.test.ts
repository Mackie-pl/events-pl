/**
 * Próg opłacalności kasuje źródło z przebiegu, więc jego błędy są kosztowne w obie strony:
 * za luźny płaci za nic, za ciasny wycina gminę z serwisu i nikt tego nie zauważy, bo
 * „brak wydarzeń w Puszczykowie" wygląda dokładnie tak samo jak „w Puszczykowie nic się nie dzieje".
 *
 * Najważniejsze są tu przypadki, w których próg ma NIE zadziałać.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { applyFbMutes, mutedSkip, verdictFor } from "../src/pipeline/extract/fb-cost-mute.js";
import type { SourceYield } from "../src/reporting/source-yield.js";
import type { PipelineState, Source } from "../src/types/index.js";

const state = (): PipelineState => ({ hashes: {}, geo: {} });

const group: Source = {
  id: "g", name: "Grupa", type: "fb_group", url: "https://www.facebook.com/groups/1",
  town: "Luboń", fetch: "fb_group", verified: true,
};

/** Źródło FB o zadanym rachunku; domyślnie z zapasem pobrań ponad minimum. */
const fb = (over: Partial<SourceYield> = {}): SourceYield => ({
  id: "g", name: "Grupa", town: "Luboń", channel: "fb", fetch: "fb_group",
  runs: 7, fetchedRuns: 7, produced: 20, distinct: 20, exclusive: 4, shared: 16,
  novel: 4, usdPerNovel: 0.25, llmUsd: 0.1, bdRecords: 600, costUsd: 1,
  status: "ok", overlaps: [], ...over,
});

/**
 * Pola NIEOBECNE, a nie ustawione na `undefined` — projekt ma `exactOptionalPropertyTypes`,
 * a różnica jest tu merytoryczna: brak `usdPerNovel` znaczy „nie da się policzyć", i to
 * właśnie ten przypadek próg musi obsłużyć osobno.
 */
function omit(row: SourceYield, ...keys: Array<keyof SourceYield>): SourceYield {
  const copy: Record<string, unknown> = { ...row };
  for (const k of keys) delete copy[k];
  return copy as unknown as SourceYield;
}

afterEach(() => {
  delete process.env["FB_MAX_USD_PER_EVENT"];
  delete process.env["FB_YIELD_MIN_RUNS"];
  delete process.env["FB_MUTE_DAYS"];
  delete process.env["FB_MIN_SOURCES_PER_TOWN"];
  delete process.env["FB_GROUP_BLOCKED_LIMIT"];
});

describe("verdictFor — kiedy próg MA nie zadziałać", () => {
  it("bez FB_MAX_USD_PER_EVENT nie wycisza niczego, choćby było skrajnie drogo", () => {
    assert.equal(verdictFor(omit(fb({ novel: 0 }), "usdPerNovel"), null), "no-threshold");
  });

  it("za mało realnych pobrań = brak werdyktu, nie werdykt negatywny", () => {
    // 4 pobrania przy domyślnym minimum 5 — jeden chudy tydzień to nie dowód
    assert.equal(verdictFor(fb({ fetchedRuns: 4, usdPerNovel: 99 }), 0.1), "too-few-runs");
  });

  it("pominięte przebiegi nie liczą się do minimum", () => {
    // źródło było w 7 przebiegach, ale pobrane tylko 2 razy (reszta: skipped-*)
    assert.equal(verdictFor(fb({ runs: 7, fetchedRuns: 2, usdPerNovel: 99 }), 0.1), "too-few-runs");
  });
});

describe("verdictFor — próg", () => {
  it("pod progiem zostaje, nad progiem leci", () => {
    assert.equal(verdictFor(fb({ usdPerNovel: 0.09 }), 0.1), "keep");
    assert.equal(verdictFor(fb({ usdPerNovel: 0.11 }), 0.1), "muted");
  });

  it("równo na progu zostaje — próg to sufit, nie granica wykluczająca", () => {
    assert.equal(verdictFor(fb({ usdPerNovel: 0.1 }), 0.1), "keep");
  });

  it("zero nowych wydarzeń to najgorszy stosunek, nie brak danych", () => {
    // wszystko, co dało, ma już któraś ze stron — dzielenie przez zero nie może wyjść na „tanio"
    assert.equal(verdictFor(omit(fb({ novel: 0 }), "usdPerNovel"), 0.1), "muted");
  });

  it("darmowe źródło bez nowych wydarzeń i tak leci (0/0 to nie jest zero kosztu)", () => {
    assert.equal(verdictFor(omit(fb({ novel: 0, costUsd: 0 }), "usdPerNovel"), 0.1), "muted");
  });
});

describe("applyFbMutes — zapis i wygasanie", () => {
  /**
   * Tania grupa w tej samej gminie. Bez niej podłoga obsady ratowałaby jedyne źródło Lubonia
   * i te testy sprawdzałyby podłogę zamiast wyciszania.
   */
  const sasiadka = fb({ id: "tania-sasiadka", usdPerNovel: 0.001 });

  it("wycisza czasowo i podaje podstawę werdyktu", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    process.env["FB_MUTE_DAYS"] = "30";
    const s = state();
    const rows = applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12");
    assert.equal(rows.find((r) => r.id === "g")?.verdict, "muted");
    assert.equal(s.fbMuted?.["g"]?.until, "2026-09-11");
    assert.equal(s.fbMuted?.["g"]?.novel, 4, "podstawa zostaje, żeby dało się werdykt sprawdzić");
  });

  it("wyciszenie wygasa samo — bez tego chudy tydzień byłby wyrokiem dożywotnim", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12");
    assert.ok(mutedSkip(group, s, "2026-09-10"), "dzień przed terminem jeszcze cisza");
    assert.equal(mutedSkip(group, s, "2026-09-11"), null, "w dniu `until` wraca do pomiaru");
  });

  it("poprawa zdejmuje wyciszenie przed terminem", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 }), sasiadka], s, "2026-08-12");
    assert.ok(s.fbMuted?.["g"], "najpierw musi być co zdejmować");
    applyFbMutes([fb({ usdPerNovel: 0.05 }), sasiadka], s, "2026-08-13");
    assert.equal(s.fbMuted?.["g"], undefined);
  });

  it("bez progu nie zapisuje wyciszeń, ale liczy wiersze do raportu", () => {
    const s = state();
    const rows = applyFbMutes([omit(fb({ novel: 0 }), "usdPerNovel")], s, "2026-08-12");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.verdict, "no-threshold");
    assert.deepEqual(s.fbMuted, {});
  });

  it("źródła spoza FB w ogóle nie wchodzą do rachunku", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.0001";
    const s = state();
    const web = omit(fb({ id: "strona", channel: "web", fetch: "plain" }), "novel", "usdPerNovel");
    const rows = applyFbMutes([web], s, "2026-08-12");
    assert.deepEqual(rows, []);
    assert.deepEqual(s.fbMuted, {});
  });

  it("zbiorczy wiersz fb-events nie da się wyciszyć, choćby nie dał nic nowego", () => {
    // to nie jest źródło z rejestru, tylko rozwiązywanie linków zebranych ze WSZYSTKICH
    // źródeł — wyciszenie wyłączyłoby wydarzenia FB w całym potoku
    process.env["FB_MAX_USD_PER_EVENT"] = "0.0001";
    const s = state();
    const rows = applyFbMutes(
      [omit(fb({ id: "fb-events", fetch: "fb_event", novel: 0 }), "usdPerNovel")], s, "2026-08-12",
    );
    assert.equal(rows[0]?.verdict, "no-threshold");
    assert.deepEqual(s.fbMuted, {});
  });

  it("fanpage FB też nie — pomijaniem fanpage'ów rządzi osobna reguła", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.0001";
    const s = state();
    applyFbMutes([omit(fb({ id: "dk-stokrotka", fetch: "fb", novel: 0 }), "usdPerNovel")], s, "2026-08-12");
    assert.deepEqual(s.fbMuted, {});
  });
});

/**
 * Próg czysto kosztowy jest stronniczy geograficznie i to nie przez jakość źródeł, tylko
 * przez arytmetykę: ten sam koszt rekordów dzieli się w gminie wiejskiej przez kilka
 * wydarzeń, a w Poznaniu przez pięćdziesiąt. Bez podłogi zdjąłby najpierw Puszczykowo,
 * Luboń i Dopiewo — czyli dokładnie te gminy, dla których ten serwis powstał.
 */
describe("podłoga obsady gminy", () => {
  const verdictOf = (rows: ReturnType<typeof applyFbMutes>, id: string): string | undefined =>
    rows.find((r) => r.id === id)?.verdict;

  it("jedyna grupa w gminie zostaje, choćby była najdroższa", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    const rows = applyFbMutes(
      [fb({ id: "kocham-puszczykowo", town: "Puszczykowo", usdPerNovel: 0.0908 })], s, "2026-08-12",
    );
    assert.equal(verdictOf(rows, "kocham-puszczykowo"), "town-floor");
    assert.deepEqual(s.fbMuted, {}, "nie może zostać zapisane jako wyciszone");
  });

  it("z trzech drogich grup w gminie zostaje NAJTAŃSZA, reszta leci", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "drogie", town: "Puszczykowo", usdPerNovel: 0.09 }),
      fb({ id: "najtansze", town: "Puszczykowo", usdPerNovel: 0.03 }),
      fb({ id: "srednie", town: "Puszczykowo", usdPerNovel: 0.05 }),
    ], s, "2026-08-12");
    assert.equal(verdictOf(rows, "najtansze"), "town-floor");
    assert.equal(verdictOf(rows, "srednie"), "muted");
    assert.equal(verdictOf(rows, "drogie"), "muted");
  });

  it("gmina z tanią grupą nie ratuje drogiej — podłoga jest już obsadzona", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "tanie", town: "Poznań", usdPerNovel: 0.002 }),
      fb({ id: "drogie", town: "Poznań", usdPerNovel: 0.09 }),
    ], s, "2026-08-12");
    assert.equal(verdictOf(rows, "tanie"), "keep");
    assert.equal(verdictOf(rows, "drogie"), "muted");
  });

  it("podłoga liczy się osobno dla każdej gminy", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "poznan-tanie", town: "Poznań", usdPerNovel: 0.002 }),
      fb({ id: "lubon-drogie", town: "Luboń", usdPerNovel: 0.09 }),
    ], s, "2026-08-12");
    assert.equal(verdictOf(rows, "lubon-drogie"), "town-floor",
      "tania grupa w Poznaniu nie obsadza Lubonia");
  });

  it("grupa niedostępna nie obsadza gminy — inaczej blokowałaby jedyną działającą", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    s.fbGroupBlocked = { prywatna: { runs: 3, since: "2026-08-01", lastTry: "2026-08-11" } };
    const rows = applyFbMutes([
      fb({ id: "prywatna", town: "Dopiewo", novel: 0, usdPerNovel: 0.5 }),
      fb({ id: "dzialajaca", town: "Dopiewo", usdPerNovel: 0.09 }),
    ], s, "2026-08-12");
    assert.equal(verdictOf(rows, "dzialajaca"), "town-floor");
    assert.equal(verdictOf(rows, "prywatna"), "muted", "niedostępnej nie ratujemy");
  });

  it("podłoga zdejmuje wyciszenie z poprzedniego przebiegu", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    // najpierw dwie grupy: droga leci
    applyFbMutes([
      fb({ id: "tanie", town: "Mosina", usdPerNovel: 0.002 }),
      fb({ id: "drogie", town: "Mosina", usdPerNovel: 0.09 }),
    ], s, "2026-08-12");
    assert.ok(s.fbMuted?.["drogie"]);
    // nazajutrz tania grupa wypada z okna — droga zostaje jedyna i musi wrócić
    applyFbMutes([fb({ id: "drogie", town: "Mosina", usdPerNovel: 0.09 })], s, "2026-08-13");
    assert.equal(s.fbMuted?.["drogie"], undefined);
  });

  it("FB_MIN_SOURCES_PER_TOWN=0 wyłącza podłogę", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "0";
    const s = state();
    const rows = applyFbMutes(
      [fb({ id: "jedyna", town: "Puszczykowo", usdPerNovel: 0.09 })], s, "2026-08-12",
    );
    assert.equal(verdictOf(rows, "jedyna"), "muted");
  });

  it("podłoga 2 zostawia dwie najtańsze", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    process.env["FB_MIN_SOURCES_PER_TOWN"] = "2";
    const s = state();
    const rows = applyFbMutes([
      fb({ id: "a", town: "Luboń", usdPerNovel: 0.09 }),
      fb({ id: "b", town: "Luboń", usdPerNovel: 0.03 }),
      fb({ id: "c", town: "Luboń", usdPerNovel: 0.05 }),
    ], s, "2026-08-12");
    assert.equal(verdictOf(rows, "b"), "town-floor");
    assert.equal(verdictOf(rows, "c"), "town-floor");
    assert.equal(verdictOf(rows, "a"), "muted");
  });

  it("źródło bez ani jednego nowego wydarzenia też może zostać podłogą", () => {
    // brak `usdPerNovel` sortuje się na koniec, ale gdy nie ma nikogo innego — ratuje je podłoga
    process.env["FB_MAX_USD_PER_EVENT"] = "0.01";
    const s = state();
    const rows = applyFbMutes(
      [omit(fb({ id: "jedyna", town: "Puszczykowo", novel: 0 }), "usdPerNovel")], s, "2026-08-12",
    );
    assert.equal(verdictOf(rows, "jedyna"), "town-floor");
  });
});
