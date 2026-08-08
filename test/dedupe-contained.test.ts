/**
 * Drugie przejście dedupe: tytuł zawarty w tytule.
 *
 * Każdy przypadek tutaj pochodzi z prawdziwego events.json (382 wydarzenia, 14 nierozpoznanych
 * par). Zapisane są też te, których scalać NIE WOLNO — bo to one wyznaczyły regułę, a bez nich
 * „scalajmy podobne tytuły" wygląda na dobry pomysł.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dedupe } from "../src/pipeline/dedupe.js";
import type { EventItem } from "../src/types/index.js";

import { event } from "./helpers.js";

const ev = (title: string, over: Partial<EventItem> = {}): EventItem =>
  event({ title, date_start: "2026-08-08", town: "Poznań", ...over });

const titles = (list: EventItem[]): string[] => list.map((e) => e.title).sort();

describe("scalanie po zawieraniu tytułu", () => {
  it("prefiks programu nie robi z jednego wydarzenia dwóch", () => {
    const r = dedupe([
      ev("10. LATO Z ESTRADĄ - ŻEGRZE - SEANS KINA PLENEROWEGO - CICHA DZIEWCZYNA"),
      ev("SEANS KINA PLENEROWEGO: „CICHA DZIEWCZYNA"),
    ]);
    assert.equal(r.events.length, 1);
    assert.equal(r.dropped[0]?.why, "zawieranie");
  });

  it("wygrywa rekord bogatszy, nie ten pierwszy", () => {
    const chudy = ev("Festiwal BLusowo");
    const gruby = ev("GOK SEZAM ZAPRASZA: FESTIWAL BLUSOWO", { venue: "Park Wojkowo", registration: "wstęp wolny" });
    assert.equal(dedupe([chudy, gruby]).events[0]?.title, gruby.title);
    assert.equal(dedupe([gruby, chudy]).events[0]?.title, gruby.title);
  });

  it("różna kolejność słów to ten sam tytuł", () => {
    assert.equal(dedupe([ev("Festiwal BLusowo"), ev("BLusowo Festiwal")]).events.length, 1);
  });

  /**
   * Ten przypadek przewrócił wariant z miarą podobieństwa: przy Jaccardzie ≥ 0.5 oba filmy
   * tego samego cyklu, tego samego dnia, scalały się w jeden — i jeden seans znikał z serwisu.
   */
  it("dwa różne filmy tego samego cyklu zostają osobno", () => {
    const r = dedupe([
      ev("Kino letnie w Wirach - Nomadland", { town: "Wiry" }),
      ev("Kino letnie w Wirach - Krudowie 2", { town: "Wiry" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  it("cykl i jego konkretny seans to jednak jedno wydarzenie", () => {
    const r = dedupe([
      ev("Kino letnie w Wirach", { town: "Wiry" }),
      ev("Kino letnie w Wirach - Nomadland", { town: "Wiry" }),
    ]);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]?.title, "Kino letnie w Wirach - Nomadland");
  });

  it("ta sama nazwa w dwóch miejscowościach to dwa wydarzenia", () => {
    const r = dedupe([
      ev("Kino letnie", { town: "Wiry" }),
      ev("Kino letnie w parku", { town: "Swarzędz" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  it("ta sama nazwa w dwóch różnych dniach to dwa wydarzenia", () => {
    const r = dedupe([
      ev("Festyn Ekologiczny", { date_start: "2026-09-19" }),
      ev("XI Festyn Ekologiczny w Kórniku", { date_start: "2026-09-20" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  /**
   * „KINO PLENEROWE" zawiera się w połowie repertuaru miasta. Brama Poznania gra swój seans,
   * Lato z Estradą swój — tego samego dnia, w tym samym mieście, w dwóch różnych miejscach.
   * Przy dwuwyrazowym tytule rozstrzyga miejsce.
   */
  it("dwuwyrazowy tytuł ogólny nie scala wydarzeń z różnych miejsc", () => {
    const r = dedupe([
      ev("10. LATO Z ESTRADĄ - ANTONINEK - KINO PLENEROWE - PERFECT DAYS", { venue: "Boisko przy SP 55" }),
      ev("KINO PLENEROWE", { venue: "Brama Poznania" }),
    ]);
    assert.equal(r.events.length, 2, "dwa pospolite słowa nie niosą tożsamości");
  });

  it("ale przy zgodnym miejscu scala nawet krótki tytuł", () => {
    const r = dedupe([
      ev("CICHE GODZINY - ZWIEDZANIE W CISZY", { venue: "Brama Poznania" }),
      ev("CICHE GODZINY", { venue: "Brama Poznania, ul. Gdańska" }),
    ]);
    assert.equal(r.events.length, 1);
  });

  it("brak miejsca to brak sprzeciwu — scalamy", () => {
    const r = dedupe([
      ev("CICHE GODZINY - ZWIEDZANIE W CISZY", { venue: "Brama Poznania" }),
      ev("CICHE GODZINY", { venue: "" }),
    ]);
    assert.equal(r.events.length, 1);
  });

  it("nie rusza wydarzeń bez części wspólnej", () => {
    const r = dedupe([ev("Koncert Chopinowski"), ev("Warsztaty ceramiczne")]);
    assert.deepEqual(titles(r.events), ["Koncert Chopinowski", "Warsztaty ceramiczne"]);
  });
});

describe("współpraca obu przejść", () => {
  it("identyczne tytuły nadal scala pierwsze przejście, z własnym powodem", () => {
    const r = dedupe([ev("Dożynki Gminne"), ev("Dożynki Gminne")]);
    assert.equal(r.events.length, 1);
    assert.equal(r.dropped[0]?.why, "klucz");
  });

  /**
   * Łańcuch: A i B mają identyczny tytuł (scala je pierwsze przejście), C zawiera ich tytuł
   * i jest bogatszy (scala drugie). Przegrany A musi wskazywać C — rekord, który FAKTYCZNIE
   * stoi w events.json — a nie B, którego tam nie ma.
   */
  it("przegrany pierwszego przejścia wskazuje ostatecznego zwycięzcę", () => {
    const a = ev("Dożynki");
    const b = ev("Dożynki", { venue: "Rynek" });
    const c = ev("Dożynki Gminne w Luboniu", {
      venue: "Rynek", registration: "wstęp wolny", conditional: "przy pogodzie",
    });
    const r = dedupe([a, b, c]);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]?.title, c.title);
    for (const d of r.dropped) {
      assert.equal(d.winner.title, c.title, `przegrany „${d.loser.title}" wskazuje rekord spoza events.json`);
    }
  });
});
