/**
 * Pomiar, który ma rozstrzygnąć, czy warto czytać plakaty z grup FB. Jego jedyna wartość
 * jest w RÓŻNICY między koszykami, więc testy pilnują przede wszystkim tego, żeby nic nie
 * wpadło do złego koszyka: ani wydarzenie z followupu, ani post bez adresu, ani przepisany
 * przez model „LINK:". Każdy taki przeciek przesuwa proporcję w stronę, w którą akurat
 * przecieka — i pomiar zaczyna potwierdzać sam siebie.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fbImagePosts } from "../src/pipeline/facebook.js";
import { fbPosterYield } from "../src/pipeline/extract/fb-poster-yield.js";
import { event as ev } from "./helpers.js";

describe("fbImagePosts — przynależność obrazu do postu", () => {
  it("post bez obrazu też wchodzi do mapy, bo bez niego nie ma koszyka odniesienia", () => {
    const m = fbImagePosts([
      { content: "Z plakatem", url: "https://fb.test/p/1", attachments: [{ url: "https://scontent.xx.fbcdn.net/a.jpg" }] },
      { content: "Sam tekst", url: "https://fb.test/p/2" },
    ]);
    assert.equal(m.get("fb.test/p/1"), 1);
    assert.equal(m.get("fb.test/p/2"), 0, "zero obrazów to informacja, nie brak wpisu");
  });

  it("wiersz błędu scrapera i post bez adresu nie wchodzą — nie ma czym ich związać", () => {
    const m = fbImagePosts([
      { error: "Group is private", attachments: [{ url: "https://scontent.xx.fbcdn.net/a.jpg" }] },
      { content: "Bez linku", photos: ["https://scontent.xx.fbcdn.net/b.jpg"] },
    ]);
    assert.equal(m.size, 0);
  });
});

describe("fbPosterYield — plon obrazu vs sam tekst", () => {
  const posts = new Map([["fb.test/p/1", 2], ["fb.test/p/2", 0], ["fb.test/p/3", 1]]);

  it("rozdziela wydarzenia na koszyki i liczy braki osobno", () => {
    const y = fbPosterYield(posts, [
      ev({ source_url: "https://fb.test/p/1", venue: "", time_start: null }),
      ev({ source_url: "https://fb.test/p/1", venue: "Zamek", time_start: "18:00" }),
      ev({ source_url: "https://fb.test/p/2", venue: "Rynek", time_start: "12:00" }),
    ]);
    assert.deepEqual(y.withImage, { posts: 2, yielded: 1, events: 2, noVenue: 1, noTime: 1 });
    assert.deepEqual(y.withoutImage, { posts: 1, yielded: 1, events: 1, noVenue: 0, noTime: 0 });
    assert.equal(y.unlinked, 0);
  });

  it("milczące posty widać po różnicy posts − yielded, także gdy nic nie wyszło", () => {
    const y = fbPosterYield(posts, []);
    assert.equal(y.withImage.posts - y.withImage.yielded, 2, "oba posty z obrazem milczą");
    assert.equal(y.withoutImage.posts - y.withoutImage.yielded, 1);
  });

  it("dwa wydarzenia z jednego postu to jeden post, który przemówił", () => {
    const y = fbPosterYield(posts, [
      ev({ source_url: "https://fb.test/p/1" }),
      ev({ source_url: "https://fb.test/p/1" }),
    ]);
    assert.equal(y.withImage.events, 2);
    assert.equal(y.withImage.yielded, 1);
  });

  it("adres przepisany przez model dopasowuje się mimo www i schematu", () => {
    const y = fbPosterYield(posts, [ev({ source_url: "http://www.fb.test/p/3/" })]);
    assert.equal(y.withImage.events, 1);
    assert.equal(y.unlinked, 0);
  });

  it("wydarzenie spoza postów (followup, zgubiony link) idzie do unlinked, nie do koszyka", () => {
    const y = fbPosterYield(posts, [
      ev({ source_url: "https://kultura.poznan.pl/plakat" }),
      ev({ source_url: "" }),
    ]);
    assert.equal(y.unlinked, 2);
    assert.equal(y.withImage.events + y.withoutImage.events, 0);
  });

  it("źródło niebędące grupą daje zera, na których auditFbPosterYield milczy", () => {
    const y = fbPosterYield(new Map(), [ev({ source_url: "https://x.test/a" })]);
    assert.equal(y.withImage.posts, 0);
    assert.equal(y.withoutImage.posts, 0);
    assert.equal(y.unlinked, 1);
  });
});
