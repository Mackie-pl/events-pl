/**
 * Helpery z src/shared/ wyglądają na trywialne, a dwa z nich są kluczami cache'ów:
 *   slug()   → id źródła → klucz ekstrakcji w state.json,
 *   urlKey() → deduplikacja rejestru (komentarz w kodzie mówi wprost, że jego poprzednia
 *              wersja wpuszczała ten sam serwis do sources.json dwa razy).
 * Cicha zmiana któregokolwiek unieważnia cache 46 źródeł i kosztuje pełny przebieg LLM.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { addDays, dayOfWeek, fmtDayPl } from "../src/shared/dates.js";
import { slug, str, trim } from "../src/shared/text.js";
import { host, isFbFetch, normalizeFbGroupUrl, urlKey } from "../src/shared/url.js";

describe("urlKey", () => {
  it("skleja warianty tego samego adresu", () => {
    const canonical = urlKey("https://www.example.pl/wydarzenia/");
    for (const v of [
      "http://example.pl/wydarzenia",
      "https://example.pl/wydarzenia/",
      "https://WWW.Example.PL/Wydarzenia",
      "https://www.example.pl/wydarzenia///",
    ]) assert.equal(urlKey(v), canonical, v);
  });

  it("różne ścieżki zostają różne", () => {
    assert.notEqual(urlKey("https://example.pl/a"), urlKey("https://example.pl/b"));
  });

  it("sortuje parametry, ale ignoruje placeholder paginacji", () => {
    assert.equal(urlKey("https://x.pl/l?b=2&a=1"), urlKey("https://x.pl/l?a=1&b=2"));
    assert.equal(urlKey("https://x.pl/l?p={page}&a=1"), urlKey("https://x.pl/l?a=1"));
  });

  it("nie wywraca się na śmieciu", () => {
    assert.equal(urlKey("nie-jest-urlem"), "nie-jest-urlem");
    assert.equal(urlKey("www.x.pl/a/"), "x.pl/a");
  });
});

describe("slug", () => {
  it("transliteruje polskie znaki", () => {
    assert.equal(slug("Gmina Luboń — Ośrodek Kultury"), "gmina-lubon-osrodek-kultury");
    assert.equal(slug("ŻŁÓBEK ĄĆĘŃŚŹ"), "zlobek-acensz");
  });

  it("nie zostawia myślników na brzegach i tnie do 48 znaków", () => {
    assert.equal(slug("!!! coś tam !!!"), "cos-tam");
    assert.equal(slug("a".repeat(80)).length, 48);
  });

  it("jest idempotentny — id przepuszczone drugi raz się nie zmienia", () => {
    const once = slug("Dom Kultury Ćmielów");
    assert.equal(slug(once), once);
  });
});

describe("trim / str", () => {
  it("trim dokłada wielokropek dopiero po przekroczeniu limitu", () => {
    assert.equal(trim("abcdef", 10), "abcdef");
    assert.equal(trim("abcdef", 3), "abc…");
  });

  it("str przepuszcza tylko niepuste napisy", () => {
    assert.equal(str("  x  "), "x");
    assert.equal(str("   "), undefined);
    assert.equal(str(""), undefined);
    assert.equal(str(42), undefined);
    assert.equal(str(null), undefined);
  });
});

describe("host / normalizeFbGroupUrl / isFbFetch", () => {
  it("host obcina www i schemat, a na śmieciu daje pusty string", () => {
    assert.equal(host("https://www.Example.PL/a?b=1"), "example.pl");
    assert.equal(host("nie-url"), "");
  });

  it("adres grupy FB sprowadza się do korzenia", () => {
    assert.equal(
      normalizeFbGroupUrl("https://www.facebook.com/groups/poznan123/posts/456/?ref=x"),
      "https://www.facebook.com/groups/poznan123",
    );
    assert.equal(normalizeFbGroupUrl("https://example.pl/a"), "https://example.pl/a");
  });

  it("strategie FB są rozpoznane, reszta nie", () => {
    assert.deepEqual(
      (["fb", "fb_group", "fb_event", "plain", "headless", "pdf", "api", "rss"] as const).map(isFbFetch),
      [true, true, true, false, false, false, false, false],
    );
  });
});

describe("dates", () => {
  it("addDays przechodzi przez granicę miesiąca i roku", () => {
    assert.equal(addDays("2026-07-31", 1), "2026-08-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-08-01", -1), "2026-07-31");
  });

  it("dayOfWeek: 0=niedziela", () => {
    assert.equal(dayOfWeek("2026-07-26"), 0);
    assert.equal(dayOfWeek("2026-08-01"), 6);
  });

  it("fmtDayPl bez wiodącego zera w dniu, z zerem w miesiącu", () => {
    assert.equal(fmtDayPl("2026-08-02"), "niedziela 2.08");
    assert.equal(fmtDayPl("2026-07-27"), "poniedziałek 27.07");
  });
});
