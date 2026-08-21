/**
 * Odsiew po lokalności. Testujemy tu WYŁĄCZNIE regułę publikacji, bo werdykt geograficzny
 * zapada w adapterze (`nominatim.ts`) i bez sieci nie da się go uczciwie sprawdzić —
 * od tego jest `test/live/geocode.live.ts`.
 *
 * Sedno: kasujemy tylko przy POZYTYWNEJ odpowiedzi „to leży gdzie indziej". Brak wiedzy
 * (`unknown`, brak pola) musi zostawiać wpis w spokoju — pomyłka w drugą stronę jest
 * niewidoczna, bo skasowanego wydarzenia nikt w digeście nie szuka.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { withinRegion } from "../src/pipeline/locality.js";
import { RUN_SCOPE, auditTrails, beginAuditRun } from "../src/shared/audit.js";
import type { SourceTrail } from "../src/types/index.js";

import { event } from "./helpers.js";

const bySource = (id: string): SourceTrail | undefined => auditTrails().find((t) => t.id === id);

beforeEach(() => { beginAuditRun(); });

describe("withinRegion — co wychodzi z potoku", () => {
  it("kasuje wyjazd za granicę", () => {
    // prawdziwy wpis z events.json (2026-08-21, dopiewo-tablica-ogloszen-fb): ma datę, cenę
    // i zapisy, więc żaden odsiew „to nie wydarzenie" go nie łapie — tylko geografia
    const out = withinRegion([
      event({ title: "WAKACJE W TURCJI | ALANYA | SAMOLOT", town: "Turcja", locality: "abroad" }),
    ]);
    assert.deepEqual(out, []);
  });

  it("kasuje miejscowość z dalszej Polski tak samo jak zagraniczną", () => {
    // wieś Szkocja leży w gminie Szubin — dla czytelnika z Mosiny to ta sama odległość,
    // co Szkocja z folderu biura podróży
    const out = withinRegion([event({ title: "Wyjazd", town: "Szkocja", locality: "far" })]);
    assert.deepEqual(out, []);
  });

  it("zostawia wpis, gdy geokoder NIE WIE, gdzie to jest", () => {
    const events = [
      event({ title: "Potańcówka", town: "Nowinki", locality: "unknown" }),
      event({ title: "Piknik", town: "" }), // pole w ogóle nieustawione — ścieżka maszynowa
    ];
    assert.equal(withinRegion(events).length, 2);
  });

  it("zostawia wpis z regionu", () => {
    const out = withinRegion([event({ title: "Dożynki", town: "Mosina", locality: "region" })]);
    assert.equal(out.length, 1);
  });

  it("każdy skasowany wpis zostawia ślad przy SWOIM źródle, a podsumowanie przy przebiegu", () => {
    withinRegion([
      event({ title: "GRECJA | KRETA", town: "Grecja", locality: "abroad", source_id: "tablica-fb" }),
      event({ title: "Wyjazd nad morze", town: "Ustka", locality: "far", source_id: "tablica-fb" }),
    ]);
    const src = bySource("tablica-fb");
    assert.equal(src?.steps.filter((s) => s.step === "event.dropped").length, 2);
    // rozbicie na zagranicę i dalszą Polskę pilnuje, czy prostokąt regionu nie zaczął kosić
    const sum = bySource(RUN_SCOPE)?.steps.at(-1);
    assert.equal(sum?.detail?.["dropped"], 2);
    assert.equal(sum?.detail?.["abroad"], 1);
  });
});
