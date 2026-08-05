/**
 * Odsiew półkolonii. Testujemy dwie rzeczy, bo obie da się złamać po cichu:
 * ZASIĘG wzorca (odmiany i pisownia bez ogonków — tak przychodzą prawdziwe tytuły i tagi)
 * oraz to, że każdy odsiany rekord zostawia ślad przy SWOIM źródle. Rekord znikający
 * z events.json bez wpisu w audit.json to dokładnie ta klasa błędu, po której nikt już
 * nie odtworzy, czemu wydarzenia nie ma.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { isCamp, withoutCamps } from "../src/pipeline/camps.js";
import { RUN_SCOPE, auditTrails, beginAuditRun } from "../src/shared/audit.js";
import type { SourceTrail } from "../src/types/index.js";

import { event } from "./helpers.js";

const bySource = (id: string): SourceTrail | undefined => auditTrails().find((t) => t.id === id);

beforeEach(() => { beginAuditRun(); });

describe("rozpoznanie półkolonii", () => {
  it("łapie odmianę i pisownię bez ogonków", () => {
    // pierwszy tytuł to prawdziwy rekord z events.json (dk-pod-lipami, ścieżka `tribe`)
    for (const title of [
      "II Turnus Letnich Półkolonii z firmą Edu3Dkacja w ODK „Słońce”",
      "Sportowo-Kulturalne Półkolonie Letnie z GOSiR w Dopiewie",
      "Zapisy na polkolonie zimowe",
      "PÓŁKOLONIA ARTYSTYCZNA",
    ]) {
      assert.equal(isCamp(event({ title })), true, title);
    }
  });

  it("łapie wpis, w którym turnus siedzi w tagu albo w kontenerze", () => {
    assert.equal(isCamp(event({ tags: ["dzieci:półkolonie", "sport"] })), true);
    assert.equal(isCamp(event({ container: "Półkolonie z GOSiR" })), true);
  });

  it("nie rusza wydarzeń, na które da się przyjść", () => {
    for (const title of [
      "Kino plenerowe na rynku",
      "Kolonia Wileńska — spotkanie podróżnicze",
      "Wakacyjne warsztaty ceramiczne",
    ]) {
      assert.equal(isCamp(event({ title })), false, title);
    }
  });
});

describe("odsiew przed scalaniem", () => {
  it("zostawia wydarzenia, a turnusy zdejmuje", () => {
    const koncert = event({ title: "Koncert w parku", source_id: "gosir" });
    const kept = withoutCamps([
      koncert,
      event({ title: "Letnie Półkolonie — turnus II", source_id: "gosir" }),
    ]);

    assert.deepEqual(kept, [koncert]);
  });

  it("zapisuje powód przy źródle, które dało rekord", () => {
    withoutCamps([event({ title: "Letnie Półkolonie", source_id: "dopiewo-gosir" })]);

    const step = bySource("dopiewo-gosir")?.steps[0];
    assert.equal(step?.step, "event.dropped");
    assert.match(step?.note ?? "", /półkolonie/i);
    assert.equal(step?.detail?.["why"], "półkolonie");
  });

  it("wydarzenie bez źródła trafia do śladu przebiegu, a nie znika", () => {
    withoutCamps([event({ title: "Półkolonie" })]); // fabryka nie ustawia source_id

    assert.equal(bySource(RUN_SCOPE)?.steps.length, 2, "rekord + podsumowanie odsiewu");
  });

  it("nie zaśmieca śladu, gdy nie było czego odsiewać", () => {
    withoutCamps([event({ title: "Koncert" })]);

    assert.deepEqual(auditTrails(), []);
  });
});
