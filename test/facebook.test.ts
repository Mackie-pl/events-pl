/**
 * Mapowanie Bright Data → EventItem jest czyste, ale pełne rozgałęzień po nazwach pól
 * (scraper zmienia je między wersjami) i po formacie daty. Dokładnie ten rodzaj kodu,
 * w którym mechaniczne przeniesienie odwraca warunek, a tsc tego nie widzi.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fbEventToItem, fbGroupPostsToText, harvestEventUrls, isEventUrl } from "../src/pipeline/facebook.js";

describe("harvestEventUrls", () => {
  it("normalizuje do kanonicznej postaci i deduplikuje", () => {
    const text = `
      https://www.facebook.com/events/123456789
      http://facebook.com/events/123456789?ref=x
      https://m.facebook.com/events/987654321/
      facebook.com/events/555
    `;
    assert.deepEqual(harvestEventUrls(text), [
      "https://www.facebook.com/events/123456789",
      "https://www.facebook.com/events/987654321",
      "https://www.facebook.com/events/555",
    ]);
  });

  it("zwraca pustą listę gdy nie ma linków", () => {
    assert.deepEqual(harvestEventUrls("zwykły tekst bez linków"), []);
  });
});

describe("isEventUrl", () => {
  it("rozpoznaje wydarzenia, odrzuca resztę FB", () => {
    assert.equal(isEventUrl("https://www.facebook.com/events/123"), true);
    assert.equal(isEventUrl("https://www.facebook.com/groups/123"), false);
    assert.equal(isEventUrl("https://example.test/events/123"), false);
  });
});

describe("fbEventToItem", () => {
  const today = "2026-07-26";

  it("mapuje rekord z datą ISO i godziną", () => {
    const item = fbEventToItem(
      {
        name: "Piknik rodzinny",
        start_date: "2026-08-01T15:00:00",
        end_date: "2026-08-02T20:00:00",
        location: "Park Sołacki",
        address: "ul. Litewska, 60-605 Poznań",
        url: "https://www.facebook.com/events/1",
        category: "Family",
      },
      today,
    );
    assert.ok(item);
    assert.equal(item.title, "Piknik rodzinny");
    assert.equal(item.date_start, "2026-08-01");
    assert.equal(item.date_end, "2026-08-02");
    assert.equal(item.time_start, "15:00");
    assert.equal(item.time_end, "20:00");
    assert.equal(item.venue, "Park Sołacki, ul. Litewska, 60-605 Poznań");
    // brak pola "city" → miasto z ostatniego segmentu adresu, bez kodu pocztowego
    assert.equal(item.town, "Poznań");
    assert.deepEqual(item.tags, ["fb:family"]);
    assert.equal(item.family_friendly, "maybe");
  });

  it("przyjmuje uniksowy timestamp (sekundy i milisekundy), ale bez godziny", () => {
    const sec = fbEventToItem({ name: "A", start_date: "1785600000" }, "2026-01-01");
    assert.equal(sec?.date_start, "2026-08-01");
    assert.equal(sec?.time_start, null, "fallback nie zgaduje godziny — uniknięcie przesunięć stref");

    const ms = fbEventToItem({ name: "A", start_date: "1785600000000" }, "2026-01-01");
    assert.equal(ms?.date_start, "2026-08-01");
  });

  it("sięga po alternatywne nazwy pól", () => {
    const item = fbEventToItem(
      { event_name: "B", startDate: "2026-08-01", place_name: "Sala", city: "Mosina" },
      today,
    );
    assert.equal(item?.title, "B");
    assert.equal(item?.town, "Mosina");
  });

  it("odrzuca wydarzenia zakończone przed dziś", () => {
    assert.equal(fbEventToItem({ name: "A", start_date: "2026-07-25" }, today), null);
    // trwające (koniec >= dziś) zostaje
    assert.ok(fbEventToItem({ name: "A", start_date: "2026-07-20", end_date: "2026-07-27" }, today));
    // zaczynające się dziś zostaje
    assert.ok(fbEventToItem({ name: "A", start_date: today }, today));
  });

  it("odrzuca rekordy bez tytułu albo bez daty", () => {
    assert.equal(fbEventToItem({ start_date: "2026-08-01" }, today), null);
    assert.equal(fbEventToItem({ name: "A" }, today), null);
    assert.equal(fbEventToItem({ name: "   ", start_date: "2026-08-01" }, today), null);
  });

  it("nie dubluje adresu, gdy nazwa miejsca już go zawiera", () => {
    const item = fbEventToItem(
      { name: "A", start_date: "2026-08-01", location: "Dom Kultury, ul. Główna 1", address: "ul. Główna 1" },
      today,
    );
    assert.equal(item?.venue, "Dom Kultury, ul. Główna 1");
  });

  it("bez kategorii daje domyślny tag", () => {
    const item = fbEventToItem({ name: "A", start_date: "2026-08-01" }, today);
    assert.deepEqual(item?.tags, ["fb:wydarzenie"]);
  });
});

describe("fbGroupPostsToText", () => {
  it("skleja posty z datą i linkiem, pomijając puste", () => {
    const out = fbGroupPostsToText([
      { content: "Treść 1", date_posted: "2026-07-20", url: "https://fb.test/p/1" },
      { content: "   " },
      { text: "Treść 2" },
    ]);
    assert.equal(
      out,
      "DATA POSTU: 2026-07-20\nLINK: https://fb.test/p/1\nTreść 1\n\n---\n\nTreść 2",
    );
  });

  it("pusta lista → pusty string", () => {
    assert.equal(fbGroupPostsToText([]), "");
  });
});
