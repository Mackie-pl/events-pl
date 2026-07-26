/**
 * Granica nieufności do odpowiedzi modelu. Typ obiecuje `date_start: string`, ale JSON
 * od LLM to zwykły `as ExtractionResult` — bez tego filtra null przeciekał do events.json
 * i cicho znikał z digestu na porównaniu `null <= "2026-08-02"` (fałsz), bez błędu i śladu.
 *
 * Testujemy przez parseModelJson, czyli przez to samo wejście, którym płynie odpowiedź
 * modelu: surowy tekst. Dzięki temu test pokrywa też wyłuskiwanie JSON-a z gadania dookoła.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
  droppedNoDateStats, parseModelJson, resetDroppedNoDate,
} from "../src/pipeline/extract/extract.js";

afterEach(() => { resetDroppedNoDate(); });

const ev = (over: Record<string, unknown> = {}) =>
  ({ title: "Koncert", date_start: "2026-08-01", is_noise: false, ...over });

const json = (events: unknown[]): string => JSON.stringify({ events });

describe("parseModelJson — odsiew wydarzeń bez daty", () => {
  it("przepuszcza wydarzenia z poprawną datą ISO", () => {
    const r = parseModelJson(json([ev(), ev({ date_start: "2026-12-31" })]));
    assert.equal(r.events.length, 2);
    assert.equal(droppedNoDateStats(), 0);
  });

  it("odrzuca null, undefined i pusty string", () => {
    const r = parseModelJson(json([
      ev({ date_start: null }), ev({ date_start: "" }), ev({ date_start: undefined }), ev(),
    ]));
    assert.equal(r.events.length, 1, "zostaje tylko to z datą");
    assert.equal(droppedNoDateStats(), 3);
  });

  it("odrzuca daty w złym formacie — kontrakt events.json to YYYY-MM-DD", () => {
    const r = parseModelJson(json([
      ev({ date_start: "01.08.2026" }), ev({ date_start: "sierpień" }),
      ev({ date_start: "2026-8-1" }), ev({ date_start: 20260801 }),
    ]));
    assert.equal(r.events.length, 0);
    assert.equal(droppedNoDateStats(), 4);
  });

  it("atrakcja stała (zoo) wypada — od tego są mapy", () => {
    const r = parseModelJson(json([
      { title: "Ogród Zoologiczny — Nowe Zoo", date_start: null, is_noise: false },
      ev({ title: "Nocne zwiedzanie zoo" }),
    ]));
    assert.deepEqual(r.events.map((e) => e.title), ["Nocne zwiedzanie zoo"]);
    assert.equal(droppedNoDateStats(), 1);
  });

  it("licznik sumuje się między wywołaniami (jedno źródło = wiele stron/plakatów)", () => {
    parseModelJson(json([ev({ date_start: null })]));
    parseModelJson(json([ev({ date_start: null }), ev({ date_start: null })]));
    assert.equal(droppedNoDateStats(), 3);
    resetDroppedNoDate();
    assert.equal(droppedNoDateStats(), 0, "reset czyści granicę źródła");
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
