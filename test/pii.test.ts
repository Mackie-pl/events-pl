/**
 * Redakcja PII to jedyny bezpiecznik między treścią strony a PUBLICZNYM repo,
 * a git utrwala każdy wyciek na zawsze. Testujemy trzy decyzje, które łatwo odwrócić
 * przy przenoszeniu pliku: komórka znika, stacjonarny zostaje, URL jest nietykalny.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { EMAIL_MARK, PHONE_MARK, newStats, redactEvent, redactEvents, redactText } from "../src/pii.js";

import { event } from "./helpers.js";

describe("redactText", () => {
  it("usuwa komórki", () => {
    assert.equal(redactText("zapisy: 601 234 567"), `zapisy: ${PHONE_MARK}`);
    assert.equal(redactText("tel. +48 512-345-678"), `tel. ${PHONE_MARK}`);
    // prefiks krajowy bez „+": wzorzec zjada też spację przed „48" (\s? w grupie prefiksu)
    assert.equal(redactText("kom. 48 733 111 222"), `kom.${PHONE_MARK}`);
  });

  // ZNANA LUKA (udokumentowana, nie naprawiona w tym refaktorze — zmieniłaby treść events.json).
  // classifyPhone ma gałąź `d.length === 13 && d.startsWith("0048")`, ale PHONE_CANDIDATE to
  // \d(?:[\s.-]?\d){7,10}, czyli maksymalnie 11 cyfr — 13-cyfrowy zapis nigdy do niej nie dociera.
  // Efekt: „0048 733 111 222" wychodzi do publicznego repo nieredagowane.
  // Test pilnuje stanu OBECNEGO, żeby przenosiny plików niczego nie zmieniły po cichu.
  it("NIE usuwa komórek w zapisie 0048 — martwa gałąź w classifyPhone", () => {
    assert.equal(redactText("kom. 0048 733 111 222"), "kom. 0048 733 111 222");
  });

  it("zostawia numery stacjonarne — to centrala instytucji, nie osoba", () => {
    assert.equal(redactText("tel. 61 123 45 67"), "tel. 61 123 45 67");
    assert.equal(redactText("tel. +48 22 123 45 67"), "tel. +48 22 123 45 67");
  });

  it("usuwa e-maile", () => {
    assert.equal(redactText("pisz: a.kowalska@dom-kultury.pl"), `pisz: ${EMAIL_MARK}`);
  });

  it("nie tyka URL-i — numeryczne id w linku wygląda jak komórka, a nią nie jest", () => {
    const url = "https://www.facebook.com/events/123456789012345";
    assert.equal(redactText(url), url);
    assert.equal(
      redactText(`szczegóły: ${url} lub 601 234 567`),
      `szczegóły: ${url} lub ${PHONE_MARK}`,
    );
  });

  it("nie rusza liczb, które nie są telefonem (daty, ceny, id)", () => {
    assert.equal(redactText("wstęp 25 zł, sala 1234"), "wstęp 25 zł, sala 1234");
  });

  it("przeżywa null z LLM mimo że typ obiecuje string", () => {
    // @ts-expect-error — celowo łamiemy typ: model potrafi zwrócić null tuż przed zapisem
    assert.equal(redactText(null), null);
  });

  it("liczy redakcje", () => {
    const stats = newStats();
    redactText("601 234 567, 602 000 111, x@y.pl", stats);
    assert.deepEqual(stats, { phones: 2, emails: 1 });
  });
});

describe("redactEvent", () => {
  it("czyści pola wolnotekstowe, zostawia strukturalne", () => {
    const stats = newStats();
    const ev = event({
      title: "Warsztaty (zapisy 601 234 567)",
      venue: "Dom Kultury",
      registration: "mail: zapisy@dk.pl",
      source_url: "https://dk.pl/events/601234567",
      price: { free: null, amount_pln: null, note: "zniżka: 512 345 678" },
      age: { min: 5, max: 10, label: "5-10 lat, info 601 234 567" },
      sub_slots: [{ time: "10:00", label: "grupa A, tel. 601 234 567", age: null }],
    });

    redactEvent(ev, stats);

    assert.equal(ev.title, `Warsztaty (zapisy ${PHONE_MARK})`);
    assert.equal(ev.registration, `mail: ${EMAIL_MARK}`);
    assert.equal(ev.price.note, `zniżka: ${PHONE_MARK}`);
    assert.equal(ev.age?.label, `5-10 lat, info ${PHONE_MARK}`);
    assert.equal(ev.sub_slots?.[0]?.label, `grupa A, tel. ${PHONE_MARK}`);
    // strukturalne nietknięte
    assert.equal(ev.venue, "Dom Kultury");
    assert.equal(ev.source_url, "https://dk.pl/events/601234567");
    assert.equal(ev.age?.min, 5);
    assert.equal(stats.phones, 4);
    assert.equal(stats.emails, 1);
  });
});

describe("redactEvents", () => {
  it("sumuje statystyki ze wszystkich wydarzeń", () => {
    const stats = redactEvents([
      event({ title: "A 601 234 567" }),
      event({ title: "B x@y.pl" }),
    ]);
    assert.deepEqual(stats, { phones: 1, emails: 1 });
  });
});
