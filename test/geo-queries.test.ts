/**
 * Drabinka zapytań do geokodera. Testujemy ją, bo jej pomyłka jest CICHA w obie strony:
 * za ostra — wydarzenie nie ma pinezki i po prostu znika z mapy, za luźna — pinezka
 * ląduje pod przypadkowym adresem i wygląda na poprawną (`hit=true` w audicie).
 *
 * Przypadki wzięte z auditu z 2026-08-14, gdzie komplet dziewięciu miejsc dostał
 * „geokoder nie zna tego adresu" — każde z nich jest w OSM.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { geoQueries } from "../src/adapters/nominatim.js";

describe("geoQueries — rozbijanie venue na człony", () => {
  it("rozdziela nazwę miejsca i adres, nazwa idzie pierwsza", () => {
    // zlepek „nazwa, adres" jako całość nie trafiał w nic
    assert.deepEqual(
      geoQueries("Hipodrom Wola, ul. Lutycka 34"),
      [{ q: "Hipodrom Wola" }, { q: "Lutycka 34" }],
    );
  });

  it("zdejmuje „ul.” — jedyny prefiks, który psuje Nominatim", () => {
    assert.deepEqual(geoQueries("ul. Śniadeckich 30"), [{ q: "Śniadeckich 30" }]);
    assert.deepEqual(geoQueries("ulica Lutycka 34"), [{ q: "Lutycka 34" }]);
  });

  it("zostawia prefiksy, na których geokoder trafia", () => {
    // sprawdzone na żywym geokoderze: „al.", „os.", „pl." nie przeszkadzają
    assert.deepEqual(geoQueries("os. Lecha 43"), [{ q: "os. Lecha 43" }]);
    assert.deepEqual(geoQueries("al. Niepodległości 16"), [{ q: "al. Niepodległości 16" }]);
    assert.deepEqual(geoQueries("pl. Wolności 1"), [{ q: "pl. Wolności 1" }]);
  });

  it("wyłuskuje miejsce ze zdania i wraca do mianownika", () => {
    // „Start: przy fontannie na placu Wolności" — etykieta, proza, odmiana naraz
    assert.deepEqual(
      geoQueries("Start: przy fontannie na placu Wolności"),
      [{ q: "plac Wolności" }],
    );
  });

  it("rozbija kilka miejsc wymienionych w jednym polu", () => {
    assert.deepEqual(
      geoQueries("Park Cytadela w Poznaniu, Lasek Marceliński w Poznaniu, Las Dębiński w Poznaniu"),
      [{ q: "Park Cytadela" }, { q: "Lasek Marceliński" }, { q: "Las Dębiński" }],
    );
  });

  it("zdejmuje miasto wtrącone w nazwę, bo doklejamy je osobno", () => {
    // „Park Cytadela w Poznaniu, Poznań, Poland" — miasto dwa razy i geokoder pudłuje
    assert.deepEqual(geoQueries("Park Cytadela w Poznaniu"), [{ q: "Park Cytadela" }]);
  });

  it("traktuje nawias jako osobny, dalszy człon", () => {
    assert.deepEqual(
      geoQueries("Sala kolumnowa, Akademia Lubrańskiego, ul. Lubrańskiego 1 (Ostrów Tumski)"),
      [{ q: "Akademia Lubrańskiego" }, { q: "Lubrańskiego 1" }, { q: "Ostrów Tumski" }],
    );
  });

  it("nie pyta o człony, które nie są miejscem", () => {
    // w Poznaniu JEST ulica Start i budynek „Hala 2" — zapytanie o nie trafia, tylko źle
    for (const generic of ["Sala kolumnowa", "Start", "Hala", "parking", "Miejsce"]) {
      assert.deepEqual(geoQueries(generic), [], `„${generic}" nie powinno iść do geokodera`);
    }
  });

  it("nie myli nazwy własnej z generykiem", () => {
    assert.deepEqual(geoQueries("Hala Arena, ul. Wyspiańskiego 33"), [{ q: "Hala Arena" }, { q: "Wyspiańskiego 33" }]);
  });

  it("nie powtarza tego samego członu", () => {
    assert.deepEqual(geoQueries("Park Wilsona, park Wilsona"), [{ q: "Park Wilsona" }]);
  });

  it("na pustym i śmieciowym wejściu nie pyta o nic", () => {
    for (const junk of ["", "  ", ",,,", "-", "??"]) assert.deepEqual(geoQueries(junk), []);
  });

  it("odcina dopowiedzenie po myślniku", () => {
    // „- garaż" to opis pomieszczenia; geokoder nie ma czego z nim zrobić
    assert.deepEqual(geoQueries("Jana Cybisa 4 - garaż"), [{ q: "Jana Cybisa 4" }]);
    assert.deepEqual(geoQueries("Rynek 1 – wejście od podwórza"), [{ q: "Rynek 1" }]);
  });

  it("nie tnie nazw, w których myślnik jest częścią nazwy", () => {
    assert.deepEqual(geoQueries("Poznań - Nowe Miasto"), [{ q: "Poznań - Nowe Miasto" }]);
  });

  it("odcina ogon przyimkowy", () => {
    assert.deepEqual(geoQueries("Park nad Wartą przy amfiteatrze"), [{ q: "Park nad Wartą" }]);
  });

  it("odrywa miejscowość sklejoną z ulicą i robi z niej miasto zapytania", () => {
    // „Mosina ul. Jana Cybisa 4" + doklejone `ev.town` = dwie miejscowości = pudło
    assert.deepEqual(
      geoQueries("Mosina ul. Jana Cybisa 4 - garaż"),
      [{ q: "Jana Cybisa 4", town: "Mosina" }],
    );
  });

  it("nie bierze prozy przed „ul.” za miejscowość", () => {
    assert.deepEqual(
      geoQueries("Muzeum Kultur Świata (wejście od ul. Mostowej 7)"),
      [{ q: "Muzeum Kultur Świata" }, { q: "Mostowej 7" }],
    );
  });
});
