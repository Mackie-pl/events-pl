/**
 * Mapowanie wyjść maszynowych na wydarzenia. Fixture'y są skrótami ODPOWIEDZI Z ŻYWYCH
 * SERWISÓW (lipiec 2026) — suchylas.pl i bracz.edu.pl — więc testują kształt, który
 * faktycznie przychodzi, a nie ten, który byłoby wygodnie założyć.
 *
 * Osobno pilnujemy dwóch rzeczy, na których ta ścieżka najłatwiej cicho zgłupieje:
 * pustego plonu (musi dać się odróżnić od udanego zera, bo uruchamia powrót do modelu)
 * i całodniowych wydarzeń (00:00–23:59 to znacznik, nie godzina rozpoczęcia).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Value } from "@sinclair/typebox/value";

import {
  bestCapability, capabilityEvents, hashableFeed, isMappable,
} from "../src/pipeline/extract/from-capability.js";
import { EventSchema } from "../src/types/event-schema.js";
import type { SourceCapability } from "../src/types/index.js";

const TODAY = "2026-07-31";

const cap = (kind: SourceCapability["kind"], datesParsed = 5): SourceCapability =>
  ({ kind, url: `https://x.pl/${kind}`, itemsSeen: 5, datesParsed, checked: TODAY });

// ---------------- wybór zdolności ----------------

describe("bestCapability", () => {
  it("woli tribe od ical — eksport iCal oddaje zwykle tylko bieżący widok kalendarza", () => {
    assert.equal(bestCapability([cap("ical"), cap("tribe")])?.kind, "tribe");
  });

  it("pomija rss i wp-rest: nie niosą terminu wydarzenia", () => {
    assert.equal(bestCapability([cap("rss"), cap("wp-rest")]), null);
  });

  it("pomija zdolność bez sparsowanych dat", () => {
    assert.equal(bestCapability([cap("tribe", 0)]), null);
  });

  it("brak zdolności to null, nie wyjątek", () => {
    assert.equal(bestCapability(), null);
    assert.equal(bestCapability([]), null);
  });

  it("odrzuca eksport pojedynczego wydarzenia — ścieżka maszynowa ZASTĘPUJE stronę", () => {
    // czerwonak-gok: przycisk „dodaj do kalendarza" wtyczki EventON. Sonda widziała tam
    // poprawny VEVENT i zapisała zdolność, ale ten adres zawsze odda to jedno wydarzenie —
    // wzięcie go za kalendarz źródła zwinęłoby całą listę imprez do jednej pozycji.
    const eventOn: SourceCapability = {
      kind: "ical", itemsSeen: 1, datesParsed: 1, checked: TODAY,
      url: "https://gok-sokol.pl/wp-admin/admin-ajax.php?action=eventon_ics_download&event_id=27886&ical=1",
    };
    assert.equal(bestCapability([eventOn]), null);
  });

  it("normalny eksport kalendarza przechodzi", () => {
    const calendar: SourceCapability = {
      kind: "ical", url: "https://bracz.edu.pl/kalendarz/?ical=1",
      itemsSeen: 2, datesParsed: 2, checked: TODAY,
    };
    assert.equal(bestCapability([calendar])?.kind, "ical");
  });

  it("isMappable zgadza się z tym, co obsługuje capabilityEvents", () => {
    assert.ok(isMappable("tribe") && isMappable("ical") && isMappable("jsonld"));
    assert.ok(!isMappable("rss") && !isMappable("wp-rest"));
  });
});

// ---------------- tribe ----------------

const TRIBE = JSON.stringify({
  events: [
    {
      title: "Zbiórka krwi dla Jeremiego",
      start_date: "2026-08-26 08:30:00", end_date: "2026-08-26 13:30:00", all_day: false,
      url: "https://www.suchylas.pl/wydarzenie/zbiorka-krwi/",
      cost: "", venue: { venue: "Świetlica w Golęczewie", city: "Suchy Las" },
      categories: [{ name: "Zdrowie" }],
    },
    {
      title: "&#8220;Grzybowe na grzybobraniu&#8221;",
      start_date: "2026-09-26 00:00:00", end_date: "2026-09-26 23:59:59", all_day: true,
      url: "https://www.suchylas.pl/wydarzenie/grzybobranie/", cost: "Bezpłatne", venue: [],
    },
    {
      title: "Impreza, która już była",
      start_date: "2026-07-01 18:00:00", end_date: "2026-07-01 20:00:00", url: "https://x.pl/stare",
    },
    { title: "Bez terminu", url: "https://x.pl/bez-daty" },
  ],
});

describe("capabilityEvents — tribe", () => {
  const plon = capabilityEvents("tribe", TRIBE, "https://x.pl/tribe", TODAY);

  it("liczy rekordy wejściowe niezależnie od plonu", () => {
    assert.equal(plon.seen, 4);
    assert.equal(plon.events.length, 2);
  });

  it("rozdziela odrzucenia na powody — inaczej „4 rekordy → 2 wydarzenia” jest zagadką", () => {
    assert.deepEqual(plon.dropped, { past: 1, noDate: 1, noTitle: 0 });
  });

  it("mapuje termin, godziny, miejsce i kategorie", () => {
    const e = plon.events[0]!;
    assert.equal(e.date_start, "2026-08-26");
    assert.equal(e.date_end, null); // ten sam dzień → nie powielamy
    assert.equal(e.time_start, "08:30");
    assert.equal(e.time_end, "13:30");
    assert.equal(e.venue, "Świetlica w Golęczewie");
    assert.equal(e.town, "Suchy Las");
    assert.deepEqual(e.tags, ["tribe:zdrowie"]);
  });

  it("całodniowe 00:00–23:59 traci godziny — to znacznik, nie termin", () => {
    const e = plon.events[1]!;
    assert.equal(e.time_start, null);
    assert.equal(e.time_end, null);
  });

  it("odkodowuje encje HTML, które WordPress wkłada nawet do JSON-a", () => {
    assert.equal(plon.events[1]!.title, "“Grzybowe na grzybobraniu”");
  });

  it("„Bezpłatne” to darmowe, puste `cost` to brak informacji — nie to samo", () => {
    assert.equal(plon.events[1]!.price.free, true);
    assert.equal(plon.events[0]!.price.free, null);
  });

  it("venue jako pusta tablica (tak WP oddaje brak miejsca) nie wywraca mapowania", () => {
    assert.equal(plon.events[1]!.venue, "");
  });

  it("klasyfikacja wieku i rodzinności zostaje otwarta — feed jej nie niesie", () => {
    for (const e of plon.events) {
      assert.equal(e.family_friendly, "maybe");
      assert.deepEqual(e.age, { min: null, max: null, label: null });
      assert.equal(e.is_noise, false);
    }
  });

  it("zepsuty JSON daje pusty plon, nie wyjątek", () => {
    const broken = capabilityEvents("tribe", "{ to nie jest json", "https://x.pl/t", TODAY);
    assert.deepEqual(broken.events, []);
    assert.equal(broken.seen, 0);
  });
});

// ---------------- iCal ----------------

// Uwaga na SUMMARY: linia jest ZŁAMANA wg RFC 5545 (kontynuacja zaczyna się spacją).
const ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Warsaw:20260731T180000",
  "DTEND;TZID=Europe/Warsaw:20260731T193000",
  "SUMMARY:Recital fortepianowy Jakuba Dery\\, wstęp wolny",
  "LOCATION:Biblioteka Raczyńskich\\, pl. Wolności 19",
  "URL:https://bracz.edu.pl/event/recital/",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260815",
  "SUMMARY:Piknik ca",
  " łodniowy",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260901T160000Z",
  "SUMMARY:Koncert podany w UTC",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("capabilityEvents — ical", () => {
  const plon = capabilityEvents("ical", ICAL, "https://x.pl/ical", TODAY);

  it("czyta wszystkie VEVENT-y", () => {
    assert.equal(plon.seen, 3);
    assert.equal(plon.events.length, 3);
  });

  it("TZID = czas ścienny, przepisujemy bez przeliczania", () => {
    const e = plon.events[0]!;
    assert.equal(e.date_start, "2026-07-31");
    assert.equal(e.time_start, "18:00");
    assert.equal(e.time_end, "19:30");
  });

  it("odkodowuje escapowane przecinki RFC 5545", () => {
    assert.equal(plon.events[0]!.title, "Recital fortepianowy Jakuba Dery, wstęp wolny");
    assert.equal(plon.events[0]!.venue, "Biblioteka Raczyńskich, pl. Wolności 19");
  });

  it("skleja złamaną linię — inaczej tytuł urywa się w połowie słowa", () => {
    assert.equal(plon.events[1]!.title, "Piknik całodniowy");
  });

  it("VALUE=DATE to cała doba — bez zmyślonej godziny", () => {
    assert.equal(plon.events[1]!.date_start, "2026-08-15");
    assert.equal(plon.events[1]!.time_start, null);
  });

  it("sufiks Z przeliczamy na Europe/Warsaw", () => {
    // 16:00 UTC 1 września = 18:00 w Warszawie (czas letni)
    assert.equal(plon.events[2]!.date_start, "2026-09-01");
    assert.equal(plon.events[2]!.time_start, "18:00");
  });

  it("kalendarz bez VEVENT-ów daje pusty plon", () => {
    const empty = capabilityEvents("ical", "BEGIN:VCALENDAR\r\nEND:VCALENDAR", "https://x.pl/i", TODAY);
    assert.equal(empty.seen, 0);
    assert.deepEqual(empty.events, []);
  });
});

// ---------------- JSON-LD ----------------

const JSONLD = `<html><script type="application/ld+json">
 {"@graph":[
   {"@type":"Event","name":"Koncert w parku","startDate":"2026-08-15T18:00:00+02:00",
    "location":{"@type":"Place","name":"Park Miejski",
                "address":{"streetAddress":"ul. Kwiatowa 1","addressLocality":"Mosina"}},
    "offers":{"@type":"Offer","price":"25"},"url":"https://osirmosina.pl/koncert"},
   {"@type":["Event","SportsEvent"],"name":"Bieg","startDate":"2026-07-10T10:00:00+02:00"},
   {"@type":"Organization","name":"OSiR"}]}</script></html>`;

describe("capabilityEvents — jsonld", () => {
  const plon = capabilityEvents("jsonld", JSONLD, "https://osirmosina.pl/kalendarz/", TODAY);

  it("bierze tylko węzły Event, także gdy @type jest tablicą", () => {
    assert.equal(plon.seen, 2);
  });

  it("odrzuca wydarzenie sprzed dziś", () => {
    assert.equal(plon.events.length, 1);
    assert.equal(plon.dropped.past, 1);
  });

  it("skleja miejsce z nazwy i adresu, miasto bierze z addressLocality", () => {
    const e = plon.events[0]!;
    assert.equal(e.venue, "Park Miejski, ul. Kwiatowa 1 Mosina");
    assert.equal(e.town, "Mosina");
    assert.equal(e.time_start, "18:00");
    assert.equal(e.price.amount_pln, 25);
  });

  it("brak własnego url → adres strony, żeby wydarzenie dało się kliknąć", () => {
    const noUrl = capabilityEvents("jsonld",
      `<script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-09-01"}</script>`,
      "https://x.pl/kalendarz", TODAY);
    assert.equal(noUrl.events[0]!.source_url, "https://x.pl/kalendarz");
  });
});

// ---------------- kontrakt schematu ----------------

describe("zgodność ze schematem wydarzenia", () => {
  it("wszystko, co mapper wypuszcza, przechodzi EventSchema", () => {
    // ścieżka maszynowa omija keepValid() z extract.ts (jak fbEventToItem), więc kontrakt
    // musi być pilnowany tutaj — inaczej niezgodny rekord doszedłby do events.json
    const all = [
      ...capabilityEvents("tribe", TRIBE, "https://x.pl/t", TODAY).events,
      ...capabilityEvents("ical", ICAL, "https://x.pl/i", TODAY).events,
      ...capabilityEvents("jsonld", JSONLD, "https://x.pl/j", TODAY).events,
    ];
    assert.ok(all.length >= 6);
    for (const ev of all) {
      const { source_id, geo, ...model } = ev;
      void source_id; void geo; // pola dokładane przez potok, spoza schematu modelu
      assert.ok(Value.Check(EventSchema, model),
        `${ev.title}: ${JSON.stringify([...Value.Errors(EventSchema, model)].slice(0, 2))}`);
    }
  });

  it("rodzaj nieobsługiwany (rss) daje pusty plon, nie wyjątek", () => {
    assert.deepEqual(capabilityEvents("rss", "<rss/>", "https://x.pl/r", TODAY).events, []);
  });
});

// ---------------- treść do haszowania ----------------

/** Odpowiedź `tribe` z dnia D: okno zapytania odbite w adresach, kalendarz bez zmian. */
const tribeOnDay = (day: string): string => JSON.stringify({
  rest_url: `https://bracz.edu.pl/wp-json/tribe/events/v1/events/?page=1&start_date=${day} 00:00:00`,
  next_rest_url: `https://bracz.edu.pl/wp-json/tribe/events/v1/events/?start_date=${day}+00%3A00%3A00&page=2`,
  total: 17, total_pages: 2, events: (JSON.parse(TRIBE) as { events: unknown[] }).events,
});

describe("hashableFeed", () => {
  it("tribe: samo przesunięcie doby w rest_url nie jest zmianą treści", () => {
    // sedno błędu: obie odpowiedzi mają tę samą DŁUGOŚĆ, więc „chars” w raporcie nic nie
    // podpowiadał — źródło meldowało `changed` co dobę, a kalendarz stał w miejscu
    const wczoraj = tribeOnDay("2026-08-10"), dzis = tribeOnDay("2026-08-11");
    assert.equal(wczoraj.length, dzis.length);
    assert.notEqual(wczoraj, dzis);
    assert.equal(hashableFeed("tribe", wczoraj), hashableFeed("tribe", dzis));
  });

  it("tribe: nowy rekord w feedzie zostaje zmianą", () => {
    const wiecej = JSON.parse(tribeOnDay("2026-08-11")) as { events: unknown[]; total: number };
    wiecej.events.push({ title: "Nowe", start_date: "2026-09-01 10:00:00" });
    wiecej.total += 1;
    assert.notEqual(hashableFeed("tribe", JSON.stringify(wiecej)),
      hashableFeed("tribe", tribeOnDay("2026-08-11")));
  });

  it("tribe: zepsuty JSON idzie do hasza w całości, bez wyjątku", () => {
    assert.equal(hashableFeed("tribe", "{ to nie jest json"), "{ to nie jest json");
  });

  it("ical: DTSTAMP to chwila eksportu, nie treść — z parametrem i bez", () => {
    const stamped = (t: string): string => [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", `DTSTAMP:${t}`,
      "DTSTART;TZID=Europe/Warsaw:20260731T180000", "SUMMARY:Recital",
      "END:VEVENT", "BEGIN:VEVENT", `DTSTAMP;VALUE=DATE-TIME:${t}`,
      "DTSTART;VALUE=DATE:20260815", "SUMMARY:Piknik", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    assert.equal(hashableFeed("ical", stamped("20260810T041500Z")),
      hashableFeed("ical", stamped("20260811T050130Z")));
  });

  it("ical: DTSTART zostaje — przesunięty termin MA być zmianą", () => {
    assert.notEqual(hashableFeed("ical", ICAL),
      hashableFeed("ical", ICAL.replace("20260731T180000", "20260731T190000")));
  });

  it("nie rusza rodzajów, których nie zna (jsonld: cała strona)", () => {
    assert.equal(hashableFeed("jsonld", JSONLD), JSONLD);
    assert.equal(hashableFeed("rss", "<rss>DTSTAMP:x</rss>"), "<rss>DTSTAMP:x</rss>");
  });
});
