/**
 * sectionsFor to czysta arytmetyka kalendarza z dwoma wyjątkami (piątek, sobota) — dokładnie
 * to, co przy przenoszeniu helperów dat do shared/dates.ts najłatwiej przesunąć o jeden dzień.
 * Daje też digestowi wyrocznię niezależną od dzisiejszej daty, bo wstrzykujemy „dziś".
 *
 * Import ../src/digest.js nie odpala main() — plik ma na końcu strażnika
 * /digest\.(ts|js)$/.test(process.argv[1]), a tu argv[1] to runner testów.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildDigest, sectionsFor } from "../src/digest.js";
import type { EventsFile } from "../src/types.js";

import { event } from "./helpers.js";

// 2026-07-26 to niedziela; kolejne dni tygodnia liczymy od niej.
const SUNDAY = "2026-07-26";
const MONDAY = "2026-07-27";
const THURSDAY = "2026-07-30";
const FRIDAY = "2026-07-31";
const SATURDAY = "2026-08-01";

const file = (events: EventsFile["events"]): EventsFile => ({
  generated: "2026-07-26T04:00:00.000Z",
  events,
  errors: [],
});

describe("sectionsFor", () => {
  it("niedziela–czwartek: JUTRO + najbliższy weekend", () => {
    const [tomorrow, weekend] = sectionsFor(SUNDAY);
    assert.equal(tomorrow?.from, MONDAY);
    assert.equal(tomorrow?.to, MONDAY);
    assert.equal(weekend?.from, SATURDAY);
    assert.equal(weekend?.to, "2026-08-02");
  });

  it("czwartek: weekend to najbliższa sobota, nie za tydzień", () => {
    const [tomorrow, weekend] = sectionsFor(THURSDAY);
    assert.equal(tomorrow?.from, FRIDAY);
    assert.equal(weekend?.from, SATURDAY);
    assert.equal(weekend?.to, "2026-08-02");
  });

  it("piątek: jedna sekcja weekendowa, bo JUTRO to już sobota", () => {
    const sections = sectionsFor(FRIDAY);
    assert.equal(sections.length, 1);
    assert.ok(sections[0]?.label.startsWith("WEEKEND"));
    assert.equal(sections[0]?.from, SATURDAY);
    assert.equal(sections[0]?.to, "2026-08-02");
  });

  it("sobota: zostaje sama niedziela", () => {
    const sections = sectionsFor(SATURDAY);
    assert.equal(sections.length, 1);
    assert.ok(sections[0]?.label.startsWith("JUTRO"));
    assert.equal(sections[0]?.from, "2026-08-02");
    assert.equal(sections[0]?.to, "2026-08-02");
  });

  it("żaden dzień tygodnia nie wypada z obsługi", () => {
    for (let i = 0; i < 7; i++) {
      const day = new Date(Date.UTC(2026, 6, 26 + i)).toISOString().slice(0, 10);
      const sections = sectionsFor(day);
      assert.ok(sections.length >= 1 && sections.length <= 2, `${day}: ${sections.length} sekcji`);
      for (const s of sections) assert.ok(s.from <= s.to, `${day}: ${s.from} > ${s.to}`);
    }
  });

  it("etykiety niosą polską nazwę dnia i datę", () => {
    assert.equal(sectionsFor(SUNDAY)[0]?.label, "JUTRO (poniedziałek 27.07)");
    assert.equal(sectionsFor(SATURDAY)[0]?.label, "JUTRO (niedziela 2.08)");
  });
});

describe("buildDigest", () => {
  it("wybiera wydarzenia z zakresu sekcji i pomija szum", () => {
    const d = buildDigest(
      file([
        event({ title: "Jutro", date_start: MONDAY }),
        event({ title: "Szum", date_start: MONDAY, is_noise: true }),
        event({ title: "Za tydzień", date_start: "2026-08-20" }),
        event({ title: "W sobotę", date_start: SATURDAY }),
      ]),
      SUNDAY,
      null,
    );
    assert.equal(d.total, 2);
    assert.ok(d.text.includes("Jutro"));
    assert.ok(d.text.includes("W sobotę"));
    assert.ok(!d.text.includes("Szum"));
    assert.ok(!d.text.includes("Za tydzień"));
  });

  it("wydarzenie wielodniowe łapie się przez nakładanie zakresów", () => {
    const d = buildDigest(
      file([event({ title: "Festiwal", date_start: "2026-07-20", date_end: "2026-08-05" })]),
      SUNDAY,
      null,
    );
    assert.equal(d.total, 2, "trwa i jutro, i w weekend — po jednym trafieniu na sekcję");
  });

  it("filtr wieku odrzuca poza przedziałem, przepuszcza bez przedziału", () => {
    const events = [
      event({ title: "Dla maluchów", date_start: MONDAY, age: { min: 2, max: 4, label: null } }),
      event({ title: "Dla starszych", date_start: MONDAY, age: { min: 12, max: null, label: null } }),
      event({ title: "Bez ograniczeń", date_start: MONDAY }),
    ];
    assert.equal(buildDigest(file(events), SUNDAY, 3).total, 2);
    assert.equal(buildDigest(file(events), SUNDAY, 13).total, 2);
    assert.equal(buildDigest(file(events), SUNDAY, null).total, 3, "bez filtru przechodzą wszystkie");
  });

  it("sortuje rodzinne na górę, potem chronologicznie", () => {
    const d = buildDigest(
      file([
        event({ title: "Późne", date_start: MONDAY, time_start: "18:00" }),
        event({ title: "Rodzinne", date_start: MONDAY, time_start: "20:00", family_friendly: true }),
        event({ title: "Wczesne", date_start: MONDAY, time_start: "09:00" }),
      ]),
      SUNDAY,
      null,
    );
    const order = ["Rodzinne", "Wczesne", "Późne"].map((t) => d.text.indexOf(t));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `kolejność: ${JSON.stringify(order)}`);
  });

  it("pusta sekcja nie znika, tylko mówi że nic nie ma", () => {
    const d = buildDigest(file([]), SUNDAY, null);
    assert.equal(d.total, 0);
    assert.ok(d.text.includes("(nic nie znaleziono)"));
    assert.equal(d.tgMessages.length, 2, "po jednej wiadomości na sekcję");
  });

  it("tnie wiadomości Telegrama poniżej limitu 4096 znaków", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      event({ title: `Wydarzenie numer ${i} z dość długim tytułem żeby urosło`, date_start: MONDAY }));
    const d = buildDigest(file(many), SUNDAY, null);
    assert.ok(d.tgMessages.length > 2, "200 pozycji musi się rozjechać na kilka wiadomości");
    for (const m of d.tgMessages) assert.ok(m.length <= 4096, `wiadomość ma ${m.length} znaków`);
  });

  it("temat wymienia sekcje i sumę", () => {
    const d = buildDigest(file([event({ date_start: MONDAY })]), SUNDAY, null);
    assert.equal(d.subject, "Wydarzenia: JUTRO + WEEKEND — 1 pozycji");
  });
});
