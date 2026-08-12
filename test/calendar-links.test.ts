/**
 * Widget „dodaj do kalendarza" jako źródło godziny — i jedyny przypadek, w którym kłamie.
 *
 * Atrapy to prawdziwe wartości ze `posir.poznan.pl/wydarzenia` (2026-08-12, 41 linków).
 * Pomiar, który wyznaczył regułę: 20 par z prawdziwym przedziałem czasu, 14 w poprawnej formie
 * całodniowej, 4 zepsute i 2 z końcem przed początkiem. Reguła ma ruszyć DOKŁADNIE te 4.
 *
 * Dlaczego nie wolno tu ciąć grubiej (linku, minut): link niesie tytuł, `location` i strefę,
 * czyli dane strukturalne lepsze od prozy, a zaokrąglenie `15:25 → 15:00` zostawia godzinę
 * wymyśloną i przy okazji psuje poprawne `19:30 → 19:00`.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fixCalendarDates } from "../src/pipeline/extract/calendar-links.js";

/** Link w takim kształcie, w jakim stoi w HTML-u POSIR-u (separator zakodowany jako %2F). */
const link = (dates: string, text = "Centralne+Kontrolne+Regaty"): string =>
  `<a href="https://www.google.com/calendar/render?action=TEMPLATE&text=${text}`
  + `&dates=${dates}&location=Malta%2C+Tor+Regatowy+Malta&ctz=Europe/Warsaw">ICS</a>`;

describe("fixCalendarDates — godzina z URL-a, gdy URL sam sobie przeczy", () => {
  it("identyczna godzina początku i końca to wpis całodniowy zapisany źle — godzina spada", () => {
    const r = fixCalendarDates(link("20261017T152500%2F20261018T152500"));

    assert.equal(r.fixed, 1);
    assert.match(r.text, /dates=20261017%2F20261018/);
    assert.equal(r.text.includes("T152500"), false, "godzina zniknęła z parametru");
  });

  it("nie rusza niczego poza parametrem dates — tytuł, miejsce i strefa zostają", () => {
    const r = fixCalendarDates(link("20261017T152500%2F20261018T152500"));

    assert.match(r.text, /text=Centralne\+Kontrolne\+Regaty/);
    assert.match(r.text, /location=Malta%2C\+Tor\+Regatowy\+Malta/);
    assert.match(r.text, /ctz=Europe\/Warsaw/);
    assert.match(r.text, /^<a href="https:\/\/www\.google\.com\/calendar\/render\?action=TEMPLATE/);
  });

  it("ten sam dzień, ta sama godzina — też spada", () => {
    // „Spływ kajakowy Warta": 20260829T114600/20260829T114600
    const r = fixCalendarDates(link("20260829T114600%2F20260829T114600"));
    assert.equal(r.fixed, 1);
    assert.match(r.text, /dates=20260829%2F20260829/);
  });

  it("PRAWDZIWY przedział czasu zostaje nietknięty", () => {
    // „Wiara Lecha - Olimpia Koło": 19:00–21:15, godzina stoi też w widocznej tabeli
    const src = link("20261114T190000%2F20261114T211500");
    const r = fixCalendarDates(src);

    assert.equal(r.fixed, 0);
    assert.equal(r.text, src);
  });

  it("koniec przed początkiem, ale godziny różne — NIE nasza sprawa", () => {
    // 20260815T193000/20260802T211500 — daty CMS sypie, ale 19:30 jest poprawne
    const src = link("20260815T193000%2F20260802T211500");
    const r = fixCalendarDates(src);

    assert.equal(r.fixed, 0, "psujemy tylko kłamstwo o GODZINIE, nie naprawiamy datowania");
    assert.equal(r.text, src);
  });

  it("poprawna forma całodniowa zostaje bez zmian", () => {
    const src = link("20260912%2F20260913");
    assert.deepEqual(fixCalendarDates(src), { text: src, fixed: 0 });
  });

  it("radzi sobie z separatorem niezakodowanym", () => {
    const r = fixCalendarDates(link("20260919T152100/20260920T152100"));
    assert.equal(r.fixed, 1);
    assert.match(r.text, /dates=20260919\/20260920/);
  });

  it("dates= POZA widgetem kalendarza jest nietykalne", () => {
    // przypadkowy parametr o tej samej nazwie w zwykłym linku serwisu
    const src = '<a href="https://example.test/raport?dates=20261017T152500/20261018T152500">x</a>';
    assert.deepEqual(fixCalendarDates(src), { text: src, fixed: 0 });
  });

  it("liczy wszystkie poprawki i zostawia sąsiadów w spokoju", () => {
    const text = [
      link("20260912T151800%2F20260913T151800", "Final+Enea"),
      link("20260912T190000%2F20260912T211500", "Mecz"),
      link("20260919T152100%2F20260920T152100", "Mistrzostwa"),
      link("20260920%2F20260921", "Kids+run"),
    ].join("\n");
    const r = fixCalendarDates(text);

    assert.equal(r.fixed, 2);
    assert.match(r.text, /dates=20260912%2F20260913/);
    assert.match(r.text, /dates=20260919%2F20260920/);
    assert.match(r.text, /dates=20260912T190000%2F20260912T211500/, "mecz nietknięty");
    assert.match(r.text, /dates=20260920%2F20260921/, "całodniowy nietknięty");
  });

  it("treść bez widgetów wraca bit w bit", () => {
    const src = "<p>Zwykła strona bez kalendarza</p>";
    assert.deepEqual(fixCalendarDates(src), { text: src, fixed: 0 });
  });
});
