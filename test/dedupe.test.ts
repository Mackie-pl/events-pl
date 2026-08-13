/**
 * Scalanie duplikatów było jedyną decyzją potoku bez śladu: wydarzenie znikało z events.json,
 * a `source_id` zmieniało się na źródło z dłuższym JSON-em — bez wpisu gdziekolwiek.
 * Testujemy więc nie samo odsiewanie, tylko RAPORT: kto przegrał i z kim.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dedupe } from "../src/pipeline/dedupe.js";
import { attachProduced } from "../src/reporting/event-refs.js";
import type { EventItem, SourceRun } from "../src/types/index.js";

import { event } from "./helpers.js";

const src = (id: string): SourceRun => ({
  id, name: id, town: "Poznań", url: `https://${id}.test/`, fetch: "plain",
  status: "ok", events: 0, followups: [], geo: { hits: 0, misses: 0 },
  llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, ms: 0,
});

/** Dłuższy JSON = bogatszy rekord, więc `venue` decyduje, kto wygra. */
const rich = (over: Partial<EventItem> = {}) => event({ venue: "Zamek, duża sala", ...over });

describe("dedupe — raport przegranych", () => {
  it("nie zgłasza nic, gdy nie ma duplikatów", () => {
    const r = dedupe([event({ title: "Koncert" }), event({ title: "Warsztaty" })]);
    assert.equal(r.events.length, 2);
    assert.deepEqual(r.dropped, []);
  });

  it("wskazuje zwycięzcę dla rekordu odrzuconego jako uboższy", () => {
    const winner = rich({ source_id: "zamek" });
    const loser = event({ source_id: "kultura" });
    const r = dedupe([winner, loser]);
    assert.equal(r.events.length, 1);
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0]?.loser, loser);
    assert.equal(r.dropped[0]?.winner, winner);
  });

  it("zgłasza rekord wypchnięty przez bogatszy, który przyszedł później", () => {
    const first = event({ source_id: "kultura" });
    const better = rich({ source_id: "zamek" });
    const r = dedupe([first, better]);
    assert.deepEqual(r.events, [better]);
    assert.equal(r.dropped[0]?.loser, first);
    assert.equal(r.dropped[0]?.winner, better);
  });

  it("w łańcuchu A→B→C wskazuje C, nie pośrednie B", () => {
    const a = event({ source_id: "a" });
    const b = rich({ source_id: "b" });
    const c = rich({ source_id: "c", registration: "zapisy mailowe w sekretariacie" });
    const r = dedupe([a, b, c]);
    assert.deepEqual(r.events, [c], "w events.json zostaje najbogatszy");
    assert.equal(r.dropped.length, 2);
    for (const d of r.dropped) assert.equal(d.winner, c, "każdy przegrany wskazuje finalistę");
  });

  it("rozróżnia wydarzenia o tym samym tytule w różnych dniach", () => {
    const r = dedupe([event({ date_start: "2026-08-01" }), event({ date_start: "2026-08-02" })]);
    assert.equal(r.events.length, 2);
    assert.deepEqual(r.dropped, []);
  });
});

describe("attachProduced — wydarzenia przypisane do źródła w przebiegu", () => {
  it("zapisuje refy również dla rekordów przegranych w dedupe", () => {
    const zamek = src("zamek");
    const kultura = src("kultura");
    const winner = rich({ title: "Koncert", source_id: "zamek" });
    const loser = event({ title: "Koncert", source_id: "kultura" });
    const solo = event({ title: "Warsztaty", source_id: "kultura" });

    const { dropped } = dedupe([winner, loser, solo]);
    attachProduced(new Map([[zamek, [winner]], [kultura, [loser, solo]]]), dropped);

    assert.deepEqual(zamek.produced?.map((p) => p.mergedInto), [undefined],
      "zwycięzca trafia do events.json, więc bez mergedInto");
    assert.equal(kultura.produced?.length, 2, "przegrany NIE znika z raportu źródła");
    assert.equal(kultura.produced?.[0]?.mergedInto, "zamek");
    assert.equal(kultura.produced?.[0]?.title, "Koncert");
    assert.equal(kultura.produced?.[1]?.mergedInto, undefined);
  });

  it("pomija źródła bez wydarzeń — pusta tablica to szum w runs.json", () => {
    const pusty = src("pusty");
    attachProduced(new Map([[pusty, []]]), []);
    assert.equal(pusty.produced, undefined);
  });

  /**
   * Scalenia się SKŁADAJĄ: kopia serii z drugiej grupy przegrywa najpierw dedupe na swoim
   * dniu, a dopiero ten zwycięzca zwija się w rytm. Klucz musi iść do końca łańcucha, bo
   * jeden krok zostawiłby ref wskazujący rekord, którego już nie ma w magazynie — i raport
   * plonu liczyłby każdy termin osobno (patrz types/run.ts, EventRef.key).
   */
  it("klucz idzie do KOŃCA łańcucha scaleń, nie o jeden krok", () => {
    const grupaA = src("a");
    const grupaB = src("b");
    const rytm = event({ title: "Zumba", date_start: "2026-09-07", source_id: "a" });
    const kolejnyTermin = event({ title: "Zumba", date_start: "2026-09-14", source_id: "a" });
    const kopiaZGrupyB = event({ title: "Zumba", date_start: "2026-09-14", source_id: "b" });

    attachProduced(
      new Map([[grupaA, [rytm, kolejnyTermin]], [grupaB, [kopiaZGrupyB]]]),
      [
        { loser: kopiaZGrupyB, winner: kolejnyTermin }, // dedupe: ten sam dzień, inne źródło
        { loser: kolejnyTermin, winner: rytm }, //          zwijanie rytmu: inny dzień, to samo źródło
      ],
    );

    const key = "zumba|2026-09-07";
    assert.equal(grupaA.produced?.[0]?.key, undefined, "rekord, który przeżył, nie stał się niczym innym");
    assert.equal(grupaA.produced?.[1]?.key, key, "drugi termin wskazuje pierwszy");
    assert.equal(grupaB.produced?.[0]?.key, key, "kopia z B po DWÓCH krokach też wskazuje pierwszy");
    assert.equal(grupaB.produced?.[0]?.mergedInto, "a", "a `mergedInto` dalej mówi o kroku pierwszym");
  });

  it("cykl w danych nie zawiesza raportu", () => {
    const zrodlo = src("z");
    const x = event({ title: "X", source_id: "z" });
    const y = event({ title: "Y", source_id: "z" });
    attachProduced(new Map([[zrodlo, [x, y]]]), [{ loser: x, winner: y }, { loser: y, winner: x }]);
    assert.equal(zrodlo.produced?.length, 2, "raport powstaje mimo cyklu");
  });

  it("redaguje tytuły przegranych — one nie przeszły przez redakcję events.json", () => {
    const zrodlo = src("zrodlo");
    // klucz dedupe to 40 znaków znormalizowanego tytułu, więc numer musi wypaść ZA tym progiem,
    // inaczej rekordy nie byłyby duplikatami i test sprawdzałby co innego, niż deklaruje
    const base = "Koncert plenerowy w parku miejskim dla rodzin z okazji lata";
    const winner = rich({ title: base, venue: "Zamek Cesarski, sala wielka na parterze" });
    const loser = event({ title: `${base} — zapisy 601234567` });

    const { dropped } = dedupe([winner, loser]);
    assert.deepEqual(dropped.map((d) => d.loser), [loser], "wygrywa rekord z venue");
    attachProduced(new Map([[zrodlo, [winner, loser]]]), dropped);

    const titles = zrodlo.produced?.map((p) => p.title).join(" ") ?? "";
    assert.ok(!titles.includes("601234567"), `komórka w runs.json: ${titles}`);
  });
});
