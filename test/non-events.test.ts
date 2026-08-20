/**
 * Odsiew wpisów, które nie są wydarzeniem. Testujemy trzy rzeczy, bo każdą da się
 * złamać po cichu: ZASIĘG wzorców (odmiany i pisownia bez ogonków — tak przychodzą
 * prawdziwe tytuły i tagi), ich WĄSKOŚĆ (regex kosi jednym słowem, a skasowanego
 * wydarzenia nikt w digeście nie zauważy) oraz to, że każdy odsiany rekord zostawia
 * ślad przy SWOIM źródle. Rekord znikający z events.json bez wpisu w audit.json to
 * dokładnie ta klasa błędu, po której nikt już nie odtworzy, czemu wydarzenia nie ma.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { isNonEvent, withoutNonEvents } from "../src/pipeline/non-events.js";
import { RUN_SCOPE, auditTrails, beginAuditRun } from "../src/shared/audit.js";
import type { SourceTrail } from "../src/types/index.js";

import { event } from "./helpers.js";

const bySource = (id: string): SourceTrail | undefined => auditTrails().find((t) => t.id === id);

beforeEach(() => { beginAuditRun(); });

describe("rozpoznanie zwolnionego terminu w usłudze", () => {
  it("łapie idiom ogłoszeń usługowych, także bez ogonków i w liczbie mnogiej", () => {
    // pierwszy tytuł to prawdziwy rekord z events.json (2026-08-20, mieszkancy-lubonia-fb-group,
    // przyszedł z PLAKATU i miał venue: "" — w digeście wyglądałby jak zwykłe wydarzenie)
    for (const title of [
      "Zwolnił się termin na stylizację dłoni lub stóp",
      "Zwolnil sie termin u fryzjera",
      "Zwolniły się dwa ostatnie terminy na paznokcie",
      "Zwolniło się miejsce na jutro",
    ]) {
      assert.equal(isNonEvent(event({ title })), true, title);
    }
  });

  it("NIE łapie wydarzeń, w których po prostu są wolne miejsca", () => {
    // wąskość jest tu ważniejsza niż zasięg: na warsztaty z zapisami przyjść MOŻNA,
    // a skasowanego wpisu nikt w digeście nie zauważy
    for (const title of [
      "Warsztaty ceramiczne — zostały wolne miejsca",
      "Wolne terminy na zwiedzanie Cytadeli",
      "Koncert — ostatnie wolne miejsca",
      "Termin spotkania z autorem",
    ]) {
      assert.equal(isNonEvent(event({ title })), false, title);
    }
  });
});

describe("rozpoznanie półkolonii", () => {
  it("łapie odmianę i pisownię bez ogonków", () => {
    // pierwszy tytuł to prawdziwy rekord z events.json (dk-pod-lipami, ścieżka `tribe`)
    for (const title of [
      "II Turnus Letnich Półkolonii z firmą Edu3Dkacja w ODK „Słońce”",
      "Sportowo-Kulturalne Półkolonie Letnie z GOSiR w Dopiewie",
      "Zapisy na polkolonie zimowe",
      "PÓŁKOLONIA ARTYSTYCZNA",
    ]) {
      assert.equal(isNonEvent(event({ title })), true, title);
    }
  });

  it("łapie wpis, w którym turnus siedzi w tagu albo w kontenerze", () => {
    assert.equal(isNonEvent(event({ tags: ["dzieci:półkolonie", "sport"] })), true);
    assert.equal(isNonEvent(event({ container: "Półkolonie z GOSiR" })), true);
  });
});

describe("rozpoznanie spotkania organizacyjnego", () => {
  it("łapie oba szyki i odmianę", () => {
    // pierwszy tytuł to prawdziwy rekord z events.json (mieszkancy-lubonia-fb-group, 2026-08-18)
    for (const title of [
      "Spotkanie organizacyjne dotyczące wyjazdu do Rewala",
      "Zebranie organizacyjne rodziców przed obozem",
      "Organizacyjne spotkanie wolontariuszy",
      "Zbiorka organizacyjna uczestnikow rajdu",
    ]) {
      assert.equal(isNonEvent(event({ title })), true, title);
    }
  });
});

describe("wąskość wzorców", () => {
  it("nie rusza wydarzeń, na które da się przyjść", () => {
    for (const title of [
      "Kino plenerowe na rynku",
      "Kolonia Wileńska — spotkanie podróżnicze",
      "Wakacyjne warsztaty ceramiczne",
      // „informacyjne" zostaje przy modelu: na takie spotkanie da się przyjść
      "Spotkanie informacyjne o dopłatach do fotowoltaiki",
      // samo słowo „organizacyjny" bez spotkania to opis imprezy, nie jej ustaleń
      "Bieg charytatywny — sprawy organizacyjne na stronie",
    ]) {
      assert.equal(isNonEvent(event({ title })), false, title);
    }
  });
});

describe("odsiew przed scalaniem", () => {
  it("zostawia wydarzenia, a nie-wydarzenia zdejmuje", () => {
    const koncert = event({ title: "Koncert w parku", source_id: "gosir" });
    const kept = withoutNonEvents([
      koncert,
      event({ title: "Letnie Półkolonie — turnus II", source_id: "gosir" }),
      event({ title: "Spotkanie organizacyjne przed wyjazdem", source_id: "gosir" }),
    ]);

    assert.deepEqual(kept, [koncert]);
  });

  it("zapisuje powód przy źródle, które dało rekord", () => {
    withoutNonEvents([event({ title: "Letnie Półkolonie", source_id: "dopiewo-gosir" })]);

    const step = bySource("dopiewo-gosir")?.steps[0];
    assert.equal(step?.step, "event.dropped");
    assert.match(step?.note ?? "", /półkolonie/i);
    assert.equal(step?.detail?.["why"], "półkolonie");
  });

  it("rozbija podsumowanie na zjawiska, żeby było widać, który wzorzec kosi", () => {
    withoutNonEvents([
      event({ title: "Półkolonie", source_id: "a" }),
      event({ title: "Półkolonie zimowe", source_id: "a" }),
      event({ title: "Spotkanie organizacyjne", source_id: "b" }),
    ]);

    const sum = bySource(RUN_SCOPE)?.steps.at(-1);
    assert.equal(sum?.detail?.["półkolonie"], 2);
    assert.equal(sum?.detail?.["spotkanie organizacyjne"], 1);
  });

  it("wydarzenie bez źródła trafia do śladu przebiegu, a nie znika", () => {
    withoutNonEvents([event({ title: "Półkolonie" })]); // fabryka nie ustawia source_id

    assert.equal(bySource(RUN_SCOPE)?.steps.length, 2, "rekord + podsumowanie odsiewu");
  });

  it("nie zaśmieca śladu, gdy nie było czego odsiewać", () => {
    withoutNonEvents([event({ title: "Koncert" })]);

    assert.deepEqual(auditTrails(), []);
  });
});
