/**
 * Granica nieufności do odpowiedzi modelu. Typ obiecuje `date_start: string`, ale JSON
 * od LLM to zwykły `as ExtractionResult` — bez tego filtra null przeciekał do events.json
 * i cicho znikał z digestu na porównaniu `null <= "2026-08-02"` (fałsz), bez błędu i śladu.
 *
 * Od lipca 2026 walidujemy CAŁY kształt schematem z types/event-schema.ts, a nie samą datę.
 * Dwa zachowania są tu równie ważne i łatwo zepsuć jedno, naprawiając drugie:
 *   - pominięty klucz to brak informacji → łatamy (model bez structured outputs oddaje
 *     regularnie sam {title, date_start} i takie wpisy dziś normalnie przechodzą),
 *   - klucz obecny ze złym typem to informacja BŁĘDNA → odrzucamy.
 *
 * Testujemy przez parseModelJson, czyli przez to samo wejście, którym płynie odpowiedź
 * modelu: surowy tekst. Dzięki temu test pokrywa też wyłuskiwanie JSON-a z gadania dookoła.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
  droppedInvalidStats, parseModelJson, resetDroppedInvalid,
} from "../src/pipeline/extract/extract.js";

afterEach(() => { resetDroppedInvalid(); });

const ev = (over: Record<string, unknown> = {}) =>
  ({ title: "Koncert", date_start: "2026-08-01", is_noise: false, ...over });

const json = (events: unknown[]): string => JSON.stringify({ events });

describe("parseModelJson — odsiew wydarzeń bez daty", () => {
  it("przepuszcza wydarzenia z poprawną datą ISO", () => {
    const r = parseModelJson(json([ev(), ev({ date_start: "2026-12-31" })]));
    assert.equal(r.events.length, 2);
    assert.equal(droppedInvalidStats(), 0);
  });

  it("odrzuca null, undefined i pusty string", () => {
    const r = parseModelJson(json([
      ev({ date_start: null }), ev({ date_start: "" }), ev({ date_start: undefined }), ev(),
    ]));
    assert.equal(r.events.length, 1, "zostaje tylko to z datą");
    assert.equal(droppedInvalidStats(), 3);
  });

  it("odrzuca daty w złym formacie — kontrakt events.json to YYYY-MM-DD", () => {
    const r = parseModelJson(json([
      ev({ date_start: "01.08.2026" }), ev({ date_start: "sierpień" }),
      ev({ date_start: "2026-8-1" }), ev({ date_start: 20260801 }),
    ]));
    assert.equal(r.events.length, 0);
    assert.equal(droppedInvalidStats(), 4);
  });

  it("atrakcja stała (zoo) wypada — od tego są mapy", () => {
    const r = parseModelJson(json([
      { title: "Ogród Zoologiczny — Nowe Zoo", date_start: null, is_noise: false },
      ev({ title: "Nocne zwiedzanie zoo" }),
    ]));
    assert.deepEqual(r.events.map((e) => e.title), ["Nocne zwiedzanie zoo"]);
    assert.equal(droppedInvalidStats(), 1);
  });

  it("licznik sumuje się między wywołaniami (jedno źródło = wiele stron/plakatów)", () => {
    parseModelJson(json([ev({ date_start: null })]));
    parseModelJson(json([ev({ date_start: null }), ev({ date_start: null })]));
    assert.equal(droppedInvalidStats(), 3);
    resetDroppedInvalid();
    assert.equal(droppedInvalidStats(), 0, "reset czyści granicę źródła");
  });

  it("zachowuje followups obok przefiltrowanych wydarzeń", () => {
    const raw = JSON.stringify({
      events: [ev({ date_start: null })],
      followups: [{ url: "https://a.pl/program.pdf", reason: "program PDF" }],
    });
    const r = parseModelJson(raw);
    assert.equal(r.events.length, 0);
    assert.equal(r.followups?.length, 1, "followup przeżywa — może właśnie on niesie daty");
  });
});

describe("parseModelJson — walidacja kształtu, nie tylko daty", () => {
  it("łata pominięte klucze zamiast wyrzucać wpis — model rzadko oddaje komplet pól", () => {
    const r = parseModelJson(json([{ title: "Koncert", date_start: "2026-08-01" }]));
    assert.equal(r.events.length, 1);
    const [e] = r.events;
    assert.equal(e?.price.free, null, "obiekt uzupełniony rekurencyjnie, nie undefined");
    assert.deepEqual(e?.tags, []);
    assert.equal(e?.family_friendly, "maybe", '„nie wiadomo" to właściwa odpowiedź, nie brak');
    assert.equal(e?.is_noise, false);
    // dwa różne „brak" i to jest celowe: pola czysto tekstowe dostają "", bo oddały swoją
    // nullowalność na budżet 16 pól unijnych; pola strukturalne zostały nullowalne
    assert.equal(e?.container, "", "pole tekstowe → pusty string");
    assert.equal(e?.venue, "");
    assert.equal(e?.date_end, null, "pole strukturalne → nadal null");
    assert.equal(e?.sub_slots, null);
    assert.equal(droppedInvalidStats(), 0);
  });

  it("odrzuca pole obecne, ale złego typu — to nie brak danych, tylko dane błędne", () => {
    const r = parseModelJson(json([
      ev({ price: "za darmo" }), ev({ tags: "koncert" }), ev({ age: { min: "cztery" } }),
      ev({ is_noise: "nie" }),
    ]));
    assert.equal(r.events.length, 0);
    assert.equal(droppedInvalidStats(), 4);
  });

  it("nie przepuszcza pól spoza schematu — additionalProperties: false", () => {
    const r = parseModelJson(json([ev({ zmyslone_pole: "cokolwiek" })]));
    assert.equal(r.events.length, 0, "halucynowany klucz to sygnał, że model zgubił schemat");
  });

  it("brak tytułu odrzuca wpis — nie ma dla niego sensownego zastępstwa", () => {
    const r = parseModelJson(json([{ date_start: "2026-08-01" }]));
    assert.equal(r.events.length, 0);
  });

  it("zagnieżdżone obiekty też są walidowane, nie tylko wierzchnia warstwa", () => {
    assert.equal(parseModelJson(json([ev({ age: { min: 4, max: null, label: null } })])).events.length, 1);
    assert.equal(parseModelJson(json([ev({ price: { free: "tak" } })])).events.length, 0);
  });
});

describe("parseModelJson — odporność na śmieci od modelu", () => {
  it("wyłuskuje JSON z gadania dookoła", () => {
    const r = parseModelJson(`Oto wynik:\n\`\`\`json\n${json([ev()])}\n\`\`\`\nGotowe.`);
    assert.equal(r.events.length, 1);
  });

  it("brak JSON-a albo zepsuty JSON → pusto, bez wyjątku", () => {
    assert.deepEqual(parseModelJson("nie znalazłem wydarzeń").events, []);
    assert.deepEqual(parseModelJson('{"events": [').events, []);
  });

  it("events nie-tablica nie wywraca przebiegu", () => {
    assert.deepEqual(parseModelJson('{"events": null}').events, []);
    assert.deepEqual(parseModelJson('{"events": "brak"}').events, []);
    assert.deepEqual(parseModelJson("{}").events, []);
  });
});
