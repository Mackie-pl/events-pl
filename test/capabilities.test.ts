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

import {
  eventDatesInText, feedCandidates, hasEventDate, itemHasEventDate, probeJsonLd,
} from "../src/pipeline/discover/capabilities.js";

/** Data odniesienia przypięta na sztywno — inaczej test przestawałby przechodzić z kalendarzem. */
const TODAY = "2026-08-01";

describe("hasEventDate — data WYDARZENIA, nie publikacji", () => {
  it("odrzuca wpis WP z samą datą publikacji", () => {
    // estrada.poznan.pl /wp-json/wp/v2/event: wpisy są, terminu nie ma (acf puste)
    assert.equal(hasEventDate({
      id: 85193, date: "2026-07-29T10:04:31", date_gmt: "2026-07-29T10:04:31",
      modified: "2026-07-29T10:04:31", title: { rendered: "Portal Film Fest | 23.08" },
      acf: [], meta: { _acf_changed: false },
    }, 0, TODAY), false);
  });

  it("przyjmuje wpis z terminem w polu wtyczki", () => {
    const record = { id: 7, date: "2026-07-01T09:00:00", start_date: "2026-08-15 18:00:00" };
    assert.equal(hasEventDate(record, 0, TODAY), true);
  });

  it("znajduje termin zagnieżdżony w meta", () => {
    assert.equal(hasEventDate({ id: 7, meta: { mec_start_date: "2026-08-15" } }, 0, TODAY), true);
  });

  it("nie bierze byle liczby za datę", () => {
    assert.equal(hasEventDate({ start_position: 3 }, 0, TODAY), false);
  });

  it("nie wchodzi w nieskończoną strukturę", () => {
    const deep = { a: { b: { c: { d: { start_date: "2026-08-15" } } } } };
    assert.equal(hasEventDate(deep, 0, TODAY), false); // głębiej niż 3 poziomy — świadomie nie szukamy
  });
});

/**
 * Regresja: `datesParsed` dla RSS liczyło się z `<pubDate>`, czyli z daty PUBLIKACJI — tej
 * samej, którą reguła tego modułu wyklucza. Efekt: KAŻDY feed świata dostawał
 * `datesParsed === itemsSeen` i wyglądał na maszynowe źródło wydarzeń. W rejestrze dało to
 * m.in. „komorniki-city rss 1000it/1000d" dla zwykłych gminnych aktualności.
 */
describe("itemHasEventDate — RSS liczy termin z TREŚCI, nie z pubDate", () => {
  const withPubDate = (inner: string): string =>
    `<item><title>Tytuł</title><pubDate>Thu, 30 Jul 2026 21:24:07 +0200</pubDate>${inner}</item>`;

  it("sam pubDate to za mało — to data publikacji wpisu", () => {
    assert.equal(itemHasEventDate(withPubDate("<description>Zapraszamy na warsztaty.</description>"), TODAY), false);
  });

  it("termin w opisie się liczy (gokkomorniki, lipiec 2026)", () => {
    assert.equal(itemHasEventDate(withPubDate(
      "<description><![CDATA[<p>wydarzenie odbędzie się w&nbsp;dniu 05.09.2026</p>]]></description>",
    ), TODAY), true);
  });

  it("termin w samym tytule też się liczy", () => {
    assert.equal(itemHasEventDate("<item><title>Portal Film Fest 23.08.2026</title></item>", TODAY), true);
  });

  it("rozpoznaje datę słowną po polsku", () => {
    const item = withPubDate("<description>Koncert 15 września na rynku.</description>");
    assert.equal(itemHasEventDate(item, TODAY), true);
  });

  it("rozpoznaje zapis ISO", () => {
    assert.equal(itemHasEventDate(withPubDate("<description>Start 2026-09-05 o 18:00.</description>"), TODAY), true);
  });

  it("Atom: entry z summary działa tak samo", () => {
    assert.equal(itemHasEventDate("<entry><title>Piknik</title><summary>12.08.2026</summary></entry>", TODAY), true);
    assert.equal(itemHasEventDate("<entry><title>Piknik</title><summary>bez terminu</summary></entry>", TODAY), false);
  });
});

/**
 * Regresja druga, tej samej rodziny: po odcięciu `<pubDate>` `datesParsed` liczyło każdą datę
 * w treści — także przeszłą. `lubon.pl/atom` dostawał 100/100, bo gminne „aktualności" są
 * pełne zdań w rodzaju „relacja z 5 lipca". Feed wyglądał na doskonałe wejście maszynowe
 * i nie niósł ani jednego przyszłego wydarzenia.
 */
describe("itemHasEventDate — termin ma być PRZYSZŁY", () => {
  const item = (text: string): string => `<item><title>Tytuł</title><description>${text}</description></item>`;

  it("relacja z przeszłego wydarzenia się NIE liczy", () => {
    assert.equal(itemHasEventDate(item("Relacja z pikniku 5 lipca."), TODAY), false);
    assert.equal(itemHasEventDate(item("Podsumowanie 12.06.2026."), TODAY), false);
  });

  it("zapowiedź na przyszłość się liczy", () => {
    assert.equal(itemHasEventDate(item("Zapraszamy 20 sierpnia."), TODAY), true);
    assert.equal(itemHasEventDate(item("Koncert 03.10.2026."), TODAY), true);
  });

  it("dzisiejszy termin jeszcze się liczy", () => {
    assert.equal(itemHasEventDate(item("Start 2026-08-01 o 18:00."), TODAY), true);
  });

  it("wpis z datą przeszłą I przyszłą liczy się raz", () => {
    // „jak co roku 5 lipca… w tym roku 20 sierpnia" — jedna przyszła wystarczy
    assert.equal(itemHasEventDate(item("Jak 5 lipca, tak i 20 sierpnia."), TODAY), true);
  });
});

describe("eventDatesInText — rozbiór zapisów", () => {
  it("czyta trzy formaty zapisu", () => {
    assert.deepEqual(eventDatesInText("05.09.2026 oraz 2026-10-11 i 7 grudnia", TODAY),
      ["2026-09-05", "2026-10-11", "2026-12-07"]);
  });

  it("zapis bez roku czyta w roku bieżącym, nie w najbliższym przyszłym", () => {
    // inaczej każda relacja z lipca wyglądałaby na zapowiedź na przyszły rok
    assert.deepEqual(eventDatesInText("5 lipca", TODAY), ["2026-07-05"]);
  });
});

describe("hasEventDate — termin przeszły to nie zdolność", () => {
  it("wtyczka z zakończonym terminem nie liczy się jako data", () => {
    assert.equal(hasEventDate({ id: 7, start_date: "2026-06-15 18:00:00" }, 0, TODAY), false);
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
