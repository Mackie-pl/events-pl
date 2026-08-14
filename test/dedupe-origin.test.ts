/**
 * Scalanie po ORYGINALE: dwa udostępnienia tego samego postu FB to jedno ogłoszenie.
 *
 * To jedyna tożsamość w potoku, która działa PONAD miejscowością — i o to w niej chodzi.
 * Ta sama treść wisi w grupach różnych gmin, a `town` domyka się wtedy miastem ŹRÓDŁA
 * (`town ??= src.town`), więc scalanie po miejscowości nie ma tych rekordów jak spotkać.
 * Pomiar z 2026-08-14: 6 z 86 oryginałów wystąpiło w więcej niż jednej grupie — m.in.
 * Akademia Urbasia (Mosina + Komorniki) i New Dance School (Komorniki + Luboń).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dedupe } from "../src/pipeline/dedupe.js";
import type { EventItem } from "../src/types/index.js";

import { event } from "./helpers.js";

const ORIG = { key: "UzpfSTEwMDA2MzgyOTU2MTg3MDoxNjI3MjUx", url: "https://www.facebook.com/reel/2155526571657733/" };

const ev = (over: Partial<EventItem> = {}): EventItem =>
  event({ title: "Wieczór Grecki", date_start: "2026-08-21", town: "Poznań", ...over });

/**
 * Tytuł IDENTYCZNY co do znaku scala już pierwsze przejście (klucz = tytuł + data), i to
 * niezależnie od miejscowości. Luka, którą łata oryginał, jest węższa: model opisuje ten sam
 * post w dwóch grupach dwoma różnymi tytułami, a wtedy rozstrzyga zawieranie — kubełkowane
 * po miejscowości, której te dwa rekordy nie mają wspólnej. Stąd tytuły w testach się różnią.
 */
describe("scalanie po oryginale udostępnienia", () => {
  const mosina = { town: "Mosina", source_id: "fb-group-co-sie-dzieje-mosina" };
  const komorniki = { town: "Komorniki", source_id: "fb-group-komorniki-ogloszenia" };

  it("ten sam oryginał w dwóch gminach to jedno wydarzenie", () => {
    const r = dedupe([
      ev({ ...mosina, origin: ORIG }),
      ev({ ...komorniki, title: "Wieczór Grecki nad Maltą", origin: ORIG }),
    ]);
    assert.equal(r.events.length, 1);
    assert.equal(r.dropped[0]?.why, "oryginał");
  });

  it("bez oryginału te same rekordy zostają osobno — to jest cała różnica", () => {
    const r = dedupe([
      ev({ ...mosina }),
      ev({ ...komorniki, title: "Wieczór Grecki nad Maltą" }),
    ]);
    assert.equal(r.events.length, 2);
  });

  /**
   * Jeden oryginał potrafi wypisać kilka wydarzeń („co się dzieje w tym tygodniu"), więc
   * wspólne id NIE znaczy „ten sam termin". Bez tego warunku scalanie po oryginale zjadałoby
   * cały program do jednej pozycji.
   */
  it("dwa RÓŻNE wydarzenia z jednego oryginału zostają osobno", () => {
    const r = dedupe([
      ev({ title: "Warsztaty z improwizacji", date_start: "2026-08-14", origin: ORIG }),
      ev({ title: "Prelekcja o regeneracji", date_start: "2026-08-16", origin: ORIG }),
    ]);
    assert.equal(r.events.length, 2);
  });

  it("wygrywa rekord bogatszy, tak jak w pozostałych przejściach", () => {
    const chudy = ev({ town: "Mosina", origin: ORIG });
    const gruby = ev({ town: "Komorniki", origin: ORIG, venue: "Restauracja Panorama", time_start: "19:00" });
    assert.equal(dedupe([chudy, gruby]).events[0]?.venue, "Restauracja Panorama");
    assert.equal(dedupe([gruby, chudy]).events[0]?.venue, "Restauracja Panorama");
  });

  it("różne oryginały nie otwierają drogi na skróty przez miejscowość", () => {
    const r = dedupe([
      ev({ ...mosina, origin: ORIG }),
      ev({ ...komorniki, title: "Wieczór Grecki nad Maltą",
        origin: { key: "inny", url: "https://www.facebook.com/reel/999/" } }),
    ]);
    assert.equal(r.events.length, 2);
  });

  /**
   * Oryginał jest przesłanką ZA scaleniem, nigdy przeciw. Identyczny tytuł i data rozstrzyga
   * pierwsze przejście — to samo wydarzenie potrafi trafić do nas raz jako repost, raz ze
   * strony organizatora, i różne (albo brakujące) `origin` nie może tego rozejść.
   */
  it("brak oryginału po jednej stronie nie blokuje pewnego scalenia", () => {
    const r = dedupe([ev({ ...mosina, origin: ORIG }), ev({ ...komorniki, source_id: "gok-www" })]);
    assert.equal(r.events.length, 1);
    assert.equal(r.dropped[0]?.why, "klucz");
  });

  /** Ślad musi prowadzić do rekordu, który NAPRAWDĘ jest w events.json — także przez trzy przejścia. */
  it("przegrany wskazuje ostatecznego zwycięzcę, nie pośrednika", () => {
    const r = dedupe([
      ev({ town: "Mosina", source_id: "a", origin: ORIG }),
      ev({ town: "Mosina", source_id: "b", origin: ORIG, venue: "Panorama" }),
      ev({ title: "Wieczór Grecki nad Maltą", town: "Mosina", source_id: "c",
        venue: "Panorama", registration: "618741100", price: { free: true, amount_pln: null, note: null } }),
    ]);
    assert.equal(r.events.length, 1);
    const winner = r.events[0]!;
    for (const d of r.dropped) assert.equal(d.winner, winner, `„${d.loser.title}" wskazuje nieistniejący rekord`);
  });
});
