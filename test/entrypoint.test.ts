/**
 * Ranking kandydatów na entrypoint — część bez sieci i bez modelu.
 *
 * Oba testy „negatywne" pilnują błędów, które heurystyka realnie popełniła na żywych
 * serwisach, zanim dostała obecny kształt.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { rankLinks } from "../src/pipeline/discover/entrypoint.js";
import type { PageLink } from "../src/shared/links.js";

const link = (url: string, text = "", inNav = false): PageLink => ({ url, text, inNav });

describe("rankLinks", () => {
  it("premiuje dział z wydarzeniami nad resztą nawigacji", () => {
    const ranked = rankLinks([
      link("https://x.pl/wydarzenia", "Wydarzenia", true),
      link("https://x.pl/kontakt", "Kontakt", true),
      link("https://x.pl/o-nas", "O nas", true),
    ], "https://x.pl/");
    assert.equal(ranked[0]?.url, "https://x.pl/wydarzenia");
  });

  it("sama obecność w menu NIE czyni kandydata", () => {
    // wcześniej `inNav` dawał +1 przy zerowej podstawie, więc do stawki wchodziło całe menu
    // i wygrywał dział z najgęstszą listą czegokolwiek (na estradzie: ogłoszenia)
    const ranked = rankLinks([
      link("https://x.pl/ogloszenia", "Ogłoszenia", true),
      link("https://x.pl/przetargi", "Przetargi", true),
    ], "https://x.pl/");
    // zostaje wyłącznie korzeń, dorzucany zawsze jako awaryjny kandydat
    assert.deepEqual(ranked.map((c) => c.url), ["https://x.pl/"]);
  });

  it("odrzuca pojedyncze wydarzenie, gdy ma na stronie rodzeństwo", () => {
    // estrada.poznan.pl: /event/<slug> pasuje do wzorca, ale to WPIS, nie lista
    const siblings = ["koncert-a-w-parku", "koncert-b-w-parku", "koncert-c-w-parku", "koncert-d-w-parku"]
      .map((s) => link(`https://x.pl/event/${s}`, "Koncert", false));
    const ranked = rankLinks([...siblings, link("https://x.pl/repertuar", "Repertuar", true)], "https://x.pl/");
    assert.ok(!ranked.some((c) => c.url.startsWith("https://x.pl/event/")),
      "adres z licznym rodzeństwem to wpis, nie dział");
    assert.equal(ranked[0]?.url, "https://x.pl/repertuar");
  });

  it("archiwum i pliki odpadają mimo pasującego słowa", () => {
    const ranked = rankLinks([
      link("https://x.pl/wydarzenia/archiwum", "Archiwum wydarzeń", true),
      link("https://x.pl/wydarzenia/program.pdf", "Program", true),
    ], "https://x.pl/");
    assert.deepEqual(ranked.map((c) => c.url), ["https://x.pl/"]);
  });

  it("korzeń zawsze zostaje w stawce — małe serwisy wypisują wydarzenia wprost na głównej", () => {
    const ranked = rankLinks([link("https://x.pl/kontakt", "Kontakt", true)], "https://x.pl/");
    assert.deepEqual(ranked.map((c) => c.url), ["https://x.pl/"]);
  });
});
