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
  it("wycisza czasowo i podaje podstawę werdyktu", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    process.env["FB_MUTE_DAYS"] = "30";
    const s = state();
    const rows = applyFbMutes([fb({ usdPerNovel: 0.25 })], s, "2026-08-12");
    assert.equal(rows[0]?.verdict, "muted");
    assert.equal(s.fbMuted?.["g"]?.until, "2026-09-11");
    assert.equal(s.fbMuted?.["g"]?.novel, 4, "podstawa zostaje, żeby dało się werdykt sprawdzić");
  });

  it("wyciszenie wygasa samo — bez tego chudy tydzień byłby wyrokiem dożywotnim", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 })], s, "2026-08-12");
    assert.ok(mutedSkip(group, s, "2026-09-10"), "dzień przed terminem jeszcze cisza");
    assert.equal(mutedSkip(group, s, "2026-09-11"), null, "w dniu `until` wraca do pomiaru");
  });

  it("poprawa zdejmuje wyciszenie przed terminem", () => {
    process.env["FB_MAX_USD_PER_EVENT"] = "0.1";
    const s = state();
    applyFbMutes([fb({ usdPerNovel: 0.25 })], s, "2026-08-12");
    applyFbMutes([fb({ usdPerNovel: 0.05 })], s, "2026-08-13");
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
