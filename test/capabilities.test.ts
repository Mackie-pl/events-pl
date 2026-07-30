/**
 * Sonda zdolności — testujemy dokładnie te przypadki, dla których powstała reguła
 * „liczy się pobranie, nie istnienie endpointu".
 *
 * Wszystkie trzy odpowiedzi poniżej pochodzą z żywych serwisów (lipiec 2026) i wszystkie trzy
 * przeszłyby test „zwraca 200". Gdyby sonda je zapisywała, rejestr twierdziłby, że trzy źródła
 * mają maszynowe wyjście z wydarzeniami — a nie ma go żadne.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { feedCandidates, hasEventDate, probeJsonLd } from "../src/pipeline/discover/capabilities.js";

describe("hasEventDate — data WYDARZENIA, nie publikacji", () => {
  it("odrzuca wpis WP z samą datą publikacji", () => {
    // estrada.poznan.pl /wp-json/wp/v2/event: wpisy są, terminu nie ma (acf puste)
    assert.equal(hasEventDate({
      id: 85193, date: "2026-07-29T10:04:31", date_gmt: "2026-07-29T10:04:31",
      modified: "2026-07-29T10:04:31", title: { rendered: "Portal Film Fest | 23.08" },
      acf: [], meta: { _acf_changed: false },
    }), false);
  });

  it("przyjmuje wpis z terminem w polu wtyczki", () => {
    assert.equal(hasEventDate({ id: 7, date: "2026-07-01T09:00:00", start_date: "2026-08-15 18:00:00" }), true);
  });

  it("znajduje termin zagnieżdżony w meta", () => {
    assert.equal(hasEventDate({ id: 7, meta: { mec_start_date: "2026-08-15" } }), true);
  });

  it("nie bierze byle liczby za datę", () => {
    assert.equal(hasEventDate({ start_position: 3 }), false);
  });

  it("nie wchodzi w nieskończoną strukturę", () => {
    const deep = { a: { b: { c: { d: { start_date: "2026-08-15" } } } } };
    assert.equal(hasEventDate(deep), false); // głębiej niż 3 poziomy — świadomie nie szukamy
  });
});

describe("probeJsonLd", () => {
  it("zlicza wydarzenia i osobno te z datą startu", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"Event","name":"Koncert","startDate":"2026-08-15T18:00"},
                 {"@type":"Event","name":"Bez daty"},
                 {"@type":"Organization","name":"GOK"}]}</script>`;
    const cap = probeJsonLd(html, "https://x.pl/wydarzenia");
    assert.equal(cap?.itemsSeen, 2);
    assert.equal(cap?.datesParsed, 1);
  });

  it("@type jako tablica też się liczy", () => {
    const html = `<script type="application/ld+json">
      {"@type":["Event","MusicEvent"],"startDate":"2026-08-15"}</script>`;
    assert.equal(probeJsonLd(html, "https://x.pl/")?.itemsSeen, 1);
  });

  it("brak JSON-LD to null, nie pusta zdolność", () => {
    assert.equal(probeJsonLd("<html><body>nic</body></html>", "https://x.pl/"), null);
  });

  it("jeden zepsuty blok nie przekreśla pozostałych", () => {
    const html = `<script type="application/ld+json">{ to nie jest json </script>
      <script type="application/ld+json">{"@type":"Event","startDate":"2026-08-15"}</script>`;
    assert.equal(probeJsonLd(html, "https://x.pl/")?.itemsSeen, 1);
  });
});

describe("feedCandidates", () => {
  it("bierze zadeklarowane feedy i dokłada ścieżki typowe dla CMS-ów gminnych", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/rss/aktualnosci_pl.xml">`;
    const found = feedCandidates(html, "https://gokkomorniki.pl/");
    assert.ok(found.includes("https://gokkomorniki.pl/rss/aktualnosci_pl.xml"));
    // 2ClickPortal ogłasza tylko część feedów — wydarzenia bywają pod nieogłoszonym adresem
    assert.ok(found.includes("https://gokkomorniki.pl/rss/wydarzenia_pl.xml"));
    assert.ok(found.includes("https://gokkomorniki.pl/feed"));
  });

  it("nie duplikuje adresu ogłoszonego i zgadywanego", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="https://x.pl/feed">`;
    const found = feedCandidates(html, "https://x.pl/");
    assert.equal(found.filter((u) => u === "https://x.pl/feed").length, 1);
  });
});
