/**
 * Cache po blokach stoi na jednym założeniu: wynik modelu zależy tylko od treści bloku.
 * Prompt zaczyna się od „Dziś jest {data}", więc NIE zależy — i te testy pilnują dwóch
 * skutków, na które się w zamian zgodziliśmy (odsiew przy odczycie i unieważnienie
 * przeterminowanego wpisu) oraz reguły, dzięki której usuwanie wydarzeń w ogóle działa.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  dropPast, lookupBlock, pruneBlocks, storeBlock, touchBlock,
} from "../src/pipeline/extract/block-cache.js";
import { unionOf } from "../src/pipeline/extract/block-source.js";
import type { PipelineState } from "../src/types/index.js";

import { event } from "./helpers.js";

const TODAY = "2026-08-07";
const state = (): PipelineState => ({ hashes: {}, geo: {} });
const day = (n: number): string => new Date(Date.parse(TODAY) + n * 86_400_000).toISOString().slice(0, 10);

describe("odsiew wydarzeń minionych", () => {
  it("zostawia przyszłe, wyrzuca zakończone i liczy ile", () => {
    const got = dropPast([
      event({ title: "jutro", date_start: day(1) }),
      event({ title: "wczoraj", date_start: day(-1) }),
      event({ title: "dziś", date_start: TODAY }),
    ], TODAY);
    assert.deepEqual(got.kept.map((e) => e.title), ["jutro", "dziś"]);
    assert.equal(got.dropped, 1);
  });

  /**
   * Najważniejszy z całego pliku. Seria „czerwiec–sierpień" ma start w przeszłości już
   * w lipcu; odsiew po `date_start` wyciąłby ją w trakcie trwania i z serwisu zniknęłoby
   * wydarzenie, które właśnie się odbywa.
   */
  it("nie wyrzuca serii, która wciąż trwa", () => {
    const trwa = event({ title: "Lato z Estradą", date_start: day(-30), date_end: day(20) });
    const skonczona = event({ title: "Wiosna", date_start: day(-60), date_end: day(-30) });
    const got = dropPast([trwa, skonczona], TODAY);
    assert.deepEqual(got.kept.map((e) => e.title), ["Lato z Estradą"]);
  });
});

describe("ważność wpisu w cache bloków", () => {
  it("oddaje wpis, dopóki choć jedno wydarzenie jest przed nami", () => {
    const s = state();
    storeBlock(s, "h1", {
      events: [event({ date_start: day(-1) }), event({ date_start: day(3) })], followups: [],
    }, TODAY);
    assert.notEqual(lookupBlock(s, "h1", TODAY), null);
  });

  /**
   * Ciche zniknięcie, przed którym broni ten test: „Jarmark Świąteczny — 12 grudnia" bywa
   * co roku bajt w bajt taki sam. Wpis z 2026 trafiłby w cache w 2027, wypadł jako miniony
   * i wydarzenie zniknęłoby z serwisu, choć się odbywa. Nieważny wpis = blok czytany od nowa.
   */
  it("unieważnia wpis, którego wszystkie wydarzenia już minęły", () => {
    const s = state();
    storeBlock(s, "jarmark", {
      events: [event({ date_start: day(-400) }), event({ date_start: day(-370) })], followups: [],
    }, day(-400));
    assert.equal(lookupBlock(s, "jarmark", TODAY), null);
  });

  it("blok bez wydarzeń żyje do TTL, potem idzie do modelu jeszcze raz", () => {
    const s = state();
    storeBlock(s, "pusty", { events: [], followups: [] }, day(-10));
    assert.notEqual(lookupBlock(s, "pusty", TODAY), null, "10 dni to jeszcze nie TTL");

    const s2 = state();
    storeBlock(s2, "pusty", { events: [], followups: [] }, day(-20));
    assert.equal(lookupBlock(s2, "pusty", TODAY), null, "po TTL wpis przestaje być wiarygodny");
  });

  it("nieznany blok to zawsze pudło", () => {
    assert.equal(lookupBlock(state(), "nigdy-nie-widziany", TODAY), null);
  });
});

describe("suma po blokach obecnych na stronie", () => {
  const withBlocks = (): PipelineState => {
    const s = state();
    storeBlock(s, "a", { events: [event({ title: "A", date_start: day(1) })], followups: ["/pdf"] }, TODAY);
    storeBlock(s, "b", { events: [event({ title: "B", date_start: day(2) })], followups: ["/pdf"] }, TODAY);
    storeBlock(s, "c", { events: [event({ title: "C", date_start: day(3) })], followups: [] }, TODAY);
    return s;
  };
  const blocks = (...hashes: string[]) => hashes.map((hash) => ({ hash, text: hash, chars: 1 }));

  it("blok, który zniknął ze strony, zabiera ze sobą wydarzenia", () => {
    // to jest CAŁY mechanizm usuwania: żadnego scalania ani odejmowania, po prostu
    // nie ma go w sumie. Przy „wyślij modelowi diff" właśnie tu dałoby się po cichu zepsuć dane.
    const got = unionOf(blocks("a", "c"), withBlocks(), TODAY);
    assert.deepEqual(got.events.map((e) => e.title), ["A", "C"]);
  });

  it("kolejność wydarzeń idzie za kolejnością bloków na stronie", () => {
    const got = unionOf(blocks("c", "a", "b"), withBlocks(), TODAY);
    assert.deepEqual(got.events.map((e) => e.title), ["C", "A", "B"]);
  });

  it("ten sam followup z dwóch bloków wchodzi raz", () => {
    const got = unionOf(blocks("a", "b"), withBlocks(), TODAY);
    assert.deepEqual(got.followups, ["/pdf"]);
  });

  it("blok nieobecny w cache nie wywraca sumy", () => {
    const got = unionOf(blocks("a", "brak"), withBlocks(), TODAY);
    assert.deepEqual(got.events.map((e) => e.title), ["A"]);
  });
});

describe("przycinanie cache bloków", () => {
  it("wyrzuca bloki niewidziane od miesiąca, zostawia świeże", () => {
    const s = state();
    storeBlock(s, "stary", { events: [], followups: [] }, day(-90));
    storeBlock(s, "swiezy", { events: [], followups: [] }, day(-90));
    touchBlock(s, "swiezy", day(-2)); // wciąż stoi na stronie, choć czytany dawno temu

    assert.equal(pruneBlocks(s, TODAY), 1);
    assert.deepEqual(Object.keys(s.blocks ?? {}), ["swiezy"]);
  });

  it("nie rusza cache'a, gdy wszystko jest świeże", () => {
    const s = state();
    storeBlock(s, "a", { events: [], followups: [] }, TODAY);
    assert.equal(pruneBlocks(s, TODAY), 0);
  });
});
