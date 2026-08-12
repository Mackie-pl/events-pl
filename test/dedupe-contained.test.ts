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

/**
 * Reguła 2: wspólny dzień + tytuł identyczny. Wszystkie atrapy to prawdziwe rekordy
 * z state.json (okpoznan-wydarzenia, 2026-08-11) — serwis wypisuje tę samą wystawę
 * w dwóch blokach jednej strony, raz jako zakres, raz jako rytm „codziennie".
 */
describe("scalanie po wspólnym dniu", () => {
  const wystawa = "Rodzinna wystawa sensoryczna \"Mela i szczun na historycznej ścieżce\"";
  /** Zakres z listy wystaw. */
  const zakres = () => ev(wystawa, { date_start: "2026-07-28", date_end: "2026-10-06" });
  /** Termin z listy „co się dzieje w tym tygodniu", po rozwinięciu rytmu „codziennie". */
  const termin = (date: string) => ev(wystawa, { date_start: date });

  it("zakres wchłania termin, który w niego wpada, choć daty startu się różnią", () => {
    const r = dedupe([zakres(), termin("2026-08-12")]);

    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]?.date_end, "2026-10-06", "zostaje zakres, nie wycinek");
    assert.equal(r.dropped[0]?.why, "zawieranie");
  });

  it("zakres wchłania WSZYSTKIE rozwinięte terminy, nie tylko pierwszy", () => {
    // to jest powód, dla którego zakres bije termin: gdyby wygrał pierwszy termin,
    // pozostałe nie miałyby już z czym się scalać i zostałyby w events.json
    const terminy = ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"].map(termin);
    for (const wejscie of [[zakres(), ...terminy], [...terminy, zakres()]]) {
      const r = dedupe(wejscie);
      assert.equal(r.events.length, 1, "kolejność wejścia nie może zmieniać wyniku");
      assert.equal(r.events[0]?.date_end, "2026-10-06");
      assert.equal(r.dropped.length, 4);
      for (const d of r.dropped) {
        assert.equal(d.winner, r.events[0], "każdy przegrany wskazuje rekord z events.json");
      }
    }
  });

  it("termin POZA zakresem zostaje osobno", () => {
    const r = dedupe([zakres(), termin("2026-10-07")]);
    assert.equal(r.events.length, 2);
  });

  it("różne miejscowości nie scalają się nawet przy wspólnym dniu", () => {
    // ta sama wystawa opisana raz jako Wolsztyn, raz jako Poznań — zostaje do osobnej decyzji
    const r = dedupe([
      ev("Wolsztyn. Historia napędzana parą", { date_start: "2026-08-03", date_end: "2026-09-30" }),
      ev("Wolsztyn. Historia napędzana parą", { date_start: "2026-08-12", town: "Wolsztyn" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  /**
   * Ostrożność reguły 2 w jednym teście: przy tytule ZAWARTYM (a nie identycznym) zakres
   * cyklu wchłonąłby każdy swój seans, bo nazwa cyklu zawiera się w nazwie seansu, a dzień
   * seansu zawsze wpada w zakres cyklu.
   */
  it("zakres cyklu NIE wchłania swojego seansu — tytuł musi być identyczny", () => {
    const r = dedupe([
      ev("Lato z Estradą", { date_start: "2026-06-01", date_end: "2026-08-31" }),
      ev("Lato z Estradą - Żegrze - seans kina plenerowego", { date_start: "2026-08-12" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  it("dwa zakresy tego samego wydarzenia o różnych granicach scalają się", () => {
    // „Pokonał Krzyżaka" stał w state.json jako 28.07–21.11 i jako 03.08–30.09
    const r = dedupe([
      ev("Pokonał Krzyżaka, zaczarował Strach", { date_start: "2026-07-28", date_end: "2026-11-21" }),
      ev("Pokonał Krzyżaka, zaczarował Strach", { date_start: "2026-08-03", date_end: "2026-09-30" }),
    ]);
    assert.equal(r.events.length, 1);
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
