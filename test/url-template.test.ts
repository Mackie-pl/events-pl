/**
 * Grupowanie odnośników w szablony to jedyny krok etapu 1, który ma darmową wyrocznię:
 * wejściem jest lista adresów, wyjściem szablon — bez sieci i bez modelu.
 *
 * Przypadki nie są wymyślone. Każdy odpowiada kształtowi, na którym heurystyka realnie
 * przegrywała podczas rozpoznania (lipiec 2026), i pilnuje, żeby nie wróciła do tamtej wersji.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detailGroup, detectPagination, groupByTemplate, urlTemplate } from "../src/shared/url-template.js";

const at = (...urls: string[]): string[] => urls;

describe("urlTemplate", () => {
  it("zwija slug wpisu, zostawia nazwę działu", () => {
    assert.equal(urlTemplate("https://x.pl/wydarzenia/dozynki-wiorka-i-czapur"), "/wydarzenia/{slug}");
    assert.equal(urlTemplate("https://x.pl/event/checki-koncert-plenerowy/"), "/event/{slug}");
  });

  it("slug z wiodącym identyfikatorem to nadal jeden slot", () => {
    // ckzamek.pl: /wydarzenia/14696-frania-piorun-spektakl-sceniczny/
    assert.equal(urlTemplate("https://x.pl/wydarzenia/14696-frania-piorun/"), "/wydarzenia/{slug}");
  });

  it("rozróżnia datę od identyfikatora — kalendarz to nie wpis", () => {
    assert.equal(urlTemplate("https://x.pl/events/2026-08-15"), "/events/{date}");
    assert.equal(urlTemplate("https://x.pl/events/8215"), "/events/{id}");
  });

  it("zachowuje rozszerzenie pliku, bo odróżnia dwa różne szablony w tym samym dziale", () => {
    assert.equal(urlTemplate("https://x.pl/mim/kultura/events/koncert-letni.html"), "/mim/kultura/events/{slug}.html");
  });

  it("krótkie człony z myślnikiem to dział, nie wpis", () => {
    assert.equal(urlTemplate("https://x.pl/o-nas"), "/o-nas");
  });

  it("parametry paginacji dostają slot, pozostałe zachowują wartość", () => {
    assert.equal(
      urlTemplate("https://x.pl/events.html?co=list&p=3"),
      "/events.html?co=list&p={page}",
    );
  });
});

describe("detailGroup", () => {
  it("wybiera listę wpisów, nie nawigację serwisu", () => {
    // mosina.pl: 6 odnośników menu w /{slug} kontra 4 prawdziwe wpisy w /wydarzenia/{slug}
    const links = [
      ...at("/o-nas", "/kontakt-z-nami", "/dla-mieszkancow", "/urzad-gminy", "/rada-gminy", "/inwestycje-gminne")
        .map((u) => ({ url: `https://x.pl${u}`, inNav: true })),
      ...at("/wydarzenia/dozynki-wiorka", "/wydarzenia/koncert-letni-w-parku",
        "/wydarzenia/noc-swietojanska-2026", "/wydarzenia/piknik-rodzinny-nad-warta")
        .map((u) => ({ url: `https://x.pl${u}`, inNav: false })),
    ];
    const g = detailGroup(links, "/wydarzenia");
    assert.equal(g?.template, "/wydarzenia/{slug}");
    assert.equal(g?.urls.length, 4);
  });

  it("kalendarz dat przegrywa z listą wydarzeń mimo przewagi liczebnej", () => {
    // kultura.poznan.pl: 33 odnośniki widoku dnia kontra 20 faktycznych wydarzeń
    const days = Array.from({ length: 12 }, (_, i) =>
      ({ url: `https://x.pl/events/2026-08-${String(i + 1).padStart(2, "0")}`, inNav: false }));
    const events = Array.from({ length: 6 }, (_, i) =>
      ({ url: `https://x.pl/events/koncert-numer-${i}-w-parku.html`, inNav: false }));
    const g = detailGroup([...days, ...events], "/events");
    assert.equal(g?.template, "/events/{slug}.html");
  });

  it("nie uznaje trzech przypadkowych adresów za listę", () => {
    assert.equal(detailGroup([{ url: "https://x.pl/jakis-dlugi-wpis", inNav: false }]), null);
  });

  it("bez informacji o nawigacji nadal działa (samo adresy)", () => {
    const urls = at("https://x.pl/a/pierwszy-wpis-listy", "https://x.pl/a/drugi-wpis-listy",
      "https://x.pl/a/trzeci-wpis-listy");
    assert.equal(detailGroup(urls, "/a")?.template, "/a/{slug}");
  });
});

describe("groupByTemplate — ranking", () => {
  it("odnośnik obecny i w menu, i w treści liczy się jako treść", () => {
    const links = [
      { url: "https://x.pl/a/wpis-pierwszy-listy", inNav: true },
      { url: "https://x.pl/a/wpis-pierwszy-listy", inNav: false },
      { url: "https://x.pl/a/wpis-drugi-listy", inNav: false },
      { url: "https://x.pl/a/wpis-trzeci-listy", inNav: false },
    ];
    const g = groupByTemplate(links).find((x) => x.template === "/a/{slug}");
    assert.equal(g?.urls.length, 3);
    assert.equal(g?.contentRatio, 1);
  });
});

describe("detectPagination", () => {
  it("rozpoznaje paginację w parametrze i podstawia {page}", () => {
    assert.equal(
      detectPagination(at("https://x.pl/wydarzenia?page=2")),
      "https://x.pl/wydarzenia?page={page}",
    );
  });

  it("rozpoznaje paginację w ścieżce /page/N", () => {
    assert.equal(
      detectPagination(at("https://x.pl/aktualnosci/page/3")),
      "https://x.pl/aktualnosci/page/{page}",
    );
  });

  it("nie myli identyfikatora wpisu z numerem strony", () => {
    assert.equal(detectPagination(at("https://x.pl/wydarzenia/12345")), null);
  });
});
