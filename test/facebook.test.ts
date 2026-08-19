/**
 * Mapowanie Bright Data → EventItem jest czyste, ale pełne rozgałęzień po nazwach pól
 * (scraper zmienia je między wersjami) i po formacie daty. Dokładnie ten rodzaj kodu,
 * w którym mechaniczne przeniesienie odwraca warunek, a tsc tego nie widzi.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  fbEventToItem, fbGroupPostsToText, fbGroupStats, fbPostExtras, harvestEventUrls, isEventUrl,
} from "../src/pipeline/facebook.js";

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

/**
 * Ten pomiar ma sterować wydatkiem (limit rekordów per grupa), więc pomyłka nie kończy się
 * brzydkim raportem, tylko rachunkiem. Najważniejsze są tu przypadki, w których tempa NIE
 * DA SIĘ policzyć — muszą zostać nierozstrzygnięte zamiast oddać zmyśloną liczbę.
 */
describe("fbGroupStats", () => {
  const post = (date: string, content = "Treść"): Record<string, unknown> =>
    ({ content, date_posted: date });

  it("liczy tempo z rozpiętości okna", () => {
    // 4 posty rozłożone na 2 doby → 2 posty/dobę
    const s = fbGroupStats([
      post("2026-08-10T12:00:00Z"), post("2026-08-09T18:00:00Z"),
      post("2026-08-09T06:00:00Z"), post("2026-08-08T12:00:00Z"),
    ], 50);
    assert.equal(s.posts, 4);
    assert.equal(s.records, 4);
    assert.equal(s.newest, "2026-08-10");
    assert.equal(s.oldest, "2026-08-08");
    assert.equal(s.spanDays, 2);
    assert.equal(s.postsPerDay, 2);
    assert.equal(s.atLimit, false, "4 z 50 — okno to cała dostępna grupa");
  });

  it("okno zerowe nie daje tempa (zamiast dzielenia przez zero)", () => {
    const s = fbGroupStats([post("2026-08-10T12:00:00Z"), post("2026-08-10T12:00:00Z")], 50);
    assert.equal(s.spanDays, 0);
    assert.equal(s.postsPerDay, undefined,
      "wiadomo tylko, że tempo jest ≥2/dobę — to nie jest pomiar tempa");
  });

  it("wyczerpany limit oznacza dolną granicę, nie pomiar", () => {
    const s = fbGroupStats([post("2026-08-10"), post("2026-08-09")], 2);
    assert.equal(s.atLimit, true);
  });

  it("wiersz błędu (include_errors) nie jest postem, ale JEST płatnym rekordem", () => {
    const s = fbGroupStats([{ error: "Group is private", error_code: "private_group" }], 50);
    assert.equal(s.records, 1, "rekord poszedł na rachunek");
    assert.equal(s.posts, 0);
    assert.equal(s.errorRows, 1);
    assert.equal(s.blockedWhy, "Group is private");
    assert.equal(s.newest, undefined);
  });

  it("posty bez czytelnej daty liczą się do rekordów, ale nie do okna", () => {
    const s = fbGroupStats([post("2026-08-10"), { content: "Bez daty" }], 50);
    assert.equal(s.posts, 2);
    assert.equal(s.spanDays, 0, "okno z jednej daty");
    assert.equal(s.postsPerDay, undefined);
  });

  it("pusta odpowiedź nie udaje pomiaru", () => {
    const s = fbGroupStats([], 50);
    assert.deepEqual(s, { records: 0, posts: 0, errorRows: 0, limit: 50, atLimit: false });
  });
});

/**
 * Pomiar tego, co ginie w spłaszczaniu. Cała wartość tej funkcji polega na tym, że ZGADUJE
 * kształt — nazwy pól datasetu nie znamy — więc test sprawdza każdy wariant, w jakim scrapery
 * oddają obrazy. Funkcja, która po cichu zwraca zero, jest tu gorsza niż jej brak: kazałaby
 * uznać, że plakatów nie ma.
 */
describe("fbPostExtras — co jest w rekordzie, a nie dochodzi do modelu", () => {
  const withImage = (over: Record<string, unknown>) => ({ content: "Ogłoszenie", ...over });

  it("znajduje URL niezależnie od kształtu pola", () => {
    const url = "https://scontent.xx.fbcdn.net/v/t39/plakat.jpg?stp=dst-jpg";
    const kształty: Record<string, unknown>[] = [
      { post_image: url },
      { photos: [url] },
      { attachments: [{ url }] },
      { media: [{ src: url }] },
    ];
    for (const k of kształty) {
      const x = fbPostExtras([withImage(k)]);
      assert.equal(x.withImage, 1, JSON.stringify(k));
      assert.equal(x.sampleImage, url, JSON.stringify(k));
      assert.equal(x.imageField, Object.keys(k)[0]);
    }
  });

  /**
   * Rekord przynosi edge najbliższy SCRAPEROWI (2026-08-17: piętnaście grup, piętnaście
   * hostów), a jeden z nich nie routował się z naszej sieci. Adres ma wychodzić z tej
   * funkcji gotowy do pobrania, bo to ostatnie miejsce znające pochodzenie rekordu.
   */
  it("adres obrazu wychodzi z generycznym edge'em, nie z tym od scrapera", () => {
    const x = fbPostExtras([withImage({
      attachments: [{ url: "https://scontent-gmp1-1.xx.fbcdn.net/v/t39/p.jpg?oe=6A8864BD" }],
    })]);
    assert.equal(x.sampleImage, "https://scontent.xx.fbcdn.net/v/t39/p.jpg?oe=6A8864BD");
  });

  it("liczy POSTY, nie obrazy — post z galerią to nadal jeden post", () => {
    const x = fbPostExtras([withImage({ photos: ["https://a.test/1.jpg", "https://a.test/2.jpg"] })]);
    assert.equal(x.withImage, 1);
  });

  it("nie liczy wierszy błędu scrapera jako postów z obrazem", () => {
    const x = fbPostExtras([{ error: "Group is private", thumbnail: "https://a.test/x.jpg" }]);
    assert.equal(x.withImage, 0);
    assert.equal(x.imageField, null);
  });

  it("wartość, która nie jest URL-em, nie udaje obrazu", () => {
    const x = fbPostExtras([withImage({ image: "brak" }), withImage({ photos: [] })]);
    assert.equal(x.withImage, 0);
    assert.equal(x.sampleImage, null);
  });

  it("osobno raportuje miejsce, które spłaszczanie też gubi", () => {
    const x = fbPostExtras([withImage({ location: "Jezioro Strzeszyńskie" })]);
    assert.equal(x.withPlace, 1);
    assert.equal(x.placeField, "location");
  });

  it("pusta odpowiedź nie udaje pomiaru", () => {
    assert.deepEqual(fbPostExtras([]), {
      imageField: null, withImage: 0, placeField: null, withPlace: 0, sampleImage: null,
      authorField: null, authors: 0, maxPostsByAuthor: 0, repeatAuthors: 0,
    });
  });

  /**
   * Wejście do pytania „czy warto ignorować sprzedawcę borówek". Test pilnuje dwóch rzeczy:
   * liczenia skupienia autorów ORAZ tego, że z funkcji nie wychodzi nic, co identyfikuje
   * osobę — `audit.json` jest commitowany w publicznym repo.
   */
  it("liczy autorów i skupienie, nie wypuszczając żadnej tożsamości", () => {
    const x = fbPostExtras([
      { content: "Borówki", url: "u1", user_url: "https://fb.test/rolnik" },
      { content: "Borówki znowu", url: "u2", user_url: "https://fb.test/rolnik" },
      { content: "Borówki i miód", url: "u3", user_url: "https://fb.test/rolnik" },
      { content: "Koncert", url: "u4", user_url: "https://fb.test/dom-kultury" },
      { error: "Group is private", user_url: "https://fb.test/ktos" },
    ]);
    assert.equal(x.authors, 2, "wiersz błędu to nie post");
    assert.equal(x.maxPostsByAuthor, 3);
    assert.equal(x.repeatAuthors, 1);
    assert.equal(x.authorField, "user_url");
    assert.equal(JSON.stringify(x).includes("rolnik"), false, "żadnej tożsamości na zewnątrz");
  });

  it("autor bywa obiektem, nie napisem — bierzemy id, nie kształt", () => {
    const x = fbPostExtras([
      { content: "A", url: "u1", author: { id: "123", name: "Jan K." } },
      { content: "B", url: "u2", author: { id: "123", name: "Jan K." } },
    ]);
    assert.equal(x.authors, 1);
    assert.equal(x.maxPostsByAuthor, 2);
    assert.equal(JSON.stringify(x).includes("Jan"), false);
  });

  it("dataset bez pola autora mówi to wprost, zamiast udawać jednego autora", () => {
    const x = fbPostExtras([{ content: "A", url: "u1" }, { content: "B", url: "u2" }]);
    assert.equal(x.authorField, null);
    assert.equal(x.authors, 0);
    assert.equal(x.maxPostsByAuthor, 0);
  });
});
