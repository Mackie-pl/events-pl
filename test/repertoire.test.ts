/**
 * Repertuar vs. wydarzenie — reguła odcinająca seanse przed pobraniem.
 *
 * WSZYSTKIE adresy w tym pliku są prawdziwe: wzięte z events.json, sources.json i runs.json
 * z 2026-08-17. Wymyślony URL dowodziłby tu wyłącznie tego, że wymyślony URL przechodzi —
 * a cała ostrożność tej reguły polega na tym, że slug „…-seans-kina-plenerowego-…" ma zostać,
 * gdy `…/seances/…` odpada.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { entryUrl } from "../src/pipeline/extract/entry-url.js";
import { dropRepertoire, repertoireSegment } from "../src/pipeline/repertoire.js";
import type { EntryPoint, Source } from "../src/types/index.js";

import { event } from "./helpers.js";

describe("repertoireSegment — repertuar poznajemy po segmencie ścieżki", () => {
  it("lista seansów odpada", () => {
    // entrypointy zapisane w sources.json przy poznan-co-gdzie-kiedy i kultura-poznan
    assert.equal(repertoireSegment("https://www.poznan.pl/mim/events/seances/"), "seances");
    assert.equal(repertoireSegment("https://kultura.poznan.pl/mim/kultura/seances/"), "seances");
  });

  it("karta pojedynczego seansu odpada tak samo", () => {
    assert.equal(
      repertoireSegment("https://kultura.poznan.pl/mim/kultura/seances/odyseja,s,33007.html"),
      "seances",
    );
  });

  it("lista wydarzeń tego samego CMS-u zostaje", () => {
    assert.equal(repertoireSegment("https://www.poznan.pl/mim/events/"), null);
    assert.equal(repertoireSegment("https://kultura.poznan.pl/mim/kultura/events/"), null);
  });

  it("słowo „seans” W SLUGU to prawdziwe wydarzenie i musi przejść", () => {
    // to jest cały powód, dla którego dopasowujemy segment, a nie podciąg adresu:
    // plenerowy pokaz filmu jest wydarzeniem, repertuar multipleksu nie jest
    const plener = "https://www.poznan.pl/mim/events/"
      + "10-lato-z-estrada-lawica-seans-kina-plenerowego-la-chimera,184270.html";
    assert.equal(repertoireSegment(plener), null);
    assert.equal(repertoireSegment("https://kultura.poznan.pl/4r0C6pFWryAyR0aFNgbv_kino-na-wolnym"), null);
    assert.equal(
      repertoireSegment("https://mok.mosina.pl/rocketman-2019-wielka-brytania-usa-kino-letnie-w-dworze-skrzynki-wstep-wolny"),
      null,
    );
  });

  it("adres nie do rozłożenia nie wywraca reguły", () => {
    assert.equal(repertoireSegment("/mim/kultura/seances/odyseja,s,33007.html"), "seances");
    assert.equal(repertoireSegment("nie-adres"), null);
  });
});

describe("dropRepertoire — odsiew wpisów podpisanych kartą seansu", () => {
  it("wpis z linkiem do seansu odpada, sąsiedni zostaje", () => {
    const out = dropRepertoire([
      event({ title: "Odyseja", source_url: "https://www.poznan.pl/mim/events/seances/odyseja,s,33007.html" }),
      event({ title: "Koncert", source_url: "https://www.poznan.pl/mim/events/" }),
    ]);
    assert.equal(out.dropped, 1);
    assert.deepEqual(out.kept.map((e) => e.title), ["Koncert"]);
  });

  it("wydarzenie bez adresu przechodzi — brak linku nie jest dowodem na repertuar", () => {
    // pusty string to sentynel „bez linku" z event-schema.ts, nie brak danych
    const out = dropRepertoire([event({ title: "Z postu FB", source_url: "" })]);
    assert.equal(out.dropped, 0);
  });
});

describe("entryUrl — repertuar nie jest punktem wejścia", () => {
  const source = (over: Partial<Source> = {}): Source => ({
    id: "poznan-co-gdzie-kiedy", name: "Co gdzie kiedy", type: "city_portal",
    url: "https://www.poznan.pl/mim/events/", town: "Poznań", fetch: "plain", verified: true, ...over,
  });

  it("entrypoint na listę seansów jest odrzucany, wchodzimy korzeniem serwisu", () => {
    // dokładnie ten wpis stoi dziś w sources.json — etap 1 wybrał go, bo miał 38 kart szczegółu
    const ep: EntryPoint = {
      url: "https://www.poznan.pl/mim/events/seances/", kind: "listing",
      confidence: 0.9, via: "llm", detailCount: 38,
    };
    const out = entryUrl(source({ entrypoints: [ep] }));
    assert.equal(out.url, "https://www.poznan.pl/mim/events/");
    assert.equal(out.entrypoint, undefined);
    assert.deepEqual(out.skipped, [{ url: ep.url, segment: "seances" }]);
  });

  it("przy dwóch entrypointach wygrywa ten, który nie jest repertuarem", () => {
    const out = entryUrl(source({
      entrypoints: [
        { url: "https://www.poznan.pl/mim/events/seances/", kind: "listing", confidence: 0.9, via: "llm" },
        { url: "https://www.poznan.pl/mim/events/kalendarz", kind: "listing", confidence: 0.6, via: "llm" },
      ],
    }));
    assert.equal(out.url, "https://www.poznan.pl/mim/events/kalendarz");
  });

  it("źródło bez repertuaru nie dostaje pola śladu", () => {
    // `skipped` pojawia się TYLKO wtedy, gdy coś odrzuciliśmy — inaczej ślad kłamie,
    // że była podejmowana decyzja
    assert.equal(entryUrl(source()).skipped, undefined);
  });
});
