/**
 * Udostępnienia w grupach FB: post niesie podpis udostępniającego, a właściwe ogłoszenie
 * siedzi w `original_post` — polu, którego potok do 2026-08 nie czytał wcale.
 *
 * Rekord w tych testach to okrojona kopia PRAWDZIWEJ odpowiedzi Bright Data dla
 * facebook.com/groups/imprezypoznan/posts/4077491349052603 (Wieczór Grecki): podpis bez
 * jednej daty, a w oryginale „📅 21 sierpnia 2026, godz. 19:00". Potok wystawił to
 * wydarzenie z datą przebiegu (2026-08-12), bo daty nigdy nie zobaczył.
 *
 * Pomiar z 2026-08-14 (221 postów, 14 grup): 43% wpisów to udostępnienia, w 31.6% z nich
 * termin jest WYŁĄCZNIE w oryginale, a przypadek odwrotny nie wystąpił ani razu — poza
 * oryginałami bez tekstu, i właśnie dlatego oryginał się DOKLEJA, a nie podstawia.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hasDateHint, postsByLink } from "../src/pipeline/extract/date-hint.js";
import { SHARED_LABEL, fbGroupPostsToText, fbOriginal, fbOriginsByPost } from "../src/pipeline/facebook.js";

const POST_URL = "https://www.facebook.com/groups/imprezypoznan/posts/4077491349052603/";
const ORIG_ID = "UzpfSTEwMDA2MzgyOTU2MTg3MDoxNjI3MjUxMDA5NDEyNTM2OjE2MjcyNTEwMDk0MTI1MzY=";

const grecki = {
  url: POST_URL,
  content: "Rezerwuj stolik na wyjątkowy Wieczór Grecki. Muzyka na żywo, pyszna kuchnia,"
    + " wernisaż sztuki i widok na Maltę w Restauracja Panorama w Hotelu HP Park",
  date_posted: "2026-08-03T12:51:57.000Z",
  original_post: {
    post_id: ORIG_ID,
    post_url: "https://www.facebook.com/reel/2155526571657733/",
    user_name: "Hotel HP Park Poznań",
    date: "2026-08-03T10:14:33.000Z",
    content: "🇬🇷 21 sierpnia Restauracja Panorama zamieni się w grecką wyspę nad Maltą!\n"
      + "📅 21 sierpnia 2026, godz. 19:00",
  },
};

/** Post własny grupy — bez `original_post`, czyli droga, którą chodzi 57% wpisów. */
const wlasny = {
  url: "https://www.facebook.com/groups/imprezypoznan/posts/111/",
  content: "Zapraszamy na salsę, już jutro na Placu Wolności!",
  date_posted: "2026-08-11T10:44:10.000Z",
};

describe("fbOriginal — wyłuskanie oryginału", () => {
  it("bierze id, adres, autora i treść", () => {
    const o = fbOriginal(grecki)!;
    assert.equal(o.key, ORIG_ID);
    assert.equal(o.url, "https://www.facebook.com/reel/2155526571657733/");
    assert.equal(o.author, "Hotel HP Park Poznań");
    assert.match(o.content, /21 sierpnia 2026, godz. 19:00/);
  });

  it("post własny nie ma oryginału", () => {
    assert.equal(fbOriginal(wlasny), null);
  });

  it("oryginał bez id ani adresu jest bezużyteczny jako tożsamość", () => {
    assert.equal(fbOriginal({ original_post: { content: "coś" } }), null);
  });
});

describe("fbGroupPostsToText — oryginał doklejany do podpisu", () => {
  const text = fbGroupPostsToText([grecki, wlasny]);

  it("do modelu idzie treść wydarzenia, nie sam podpis", () => {
    assert.match(text, /21 sierpnia 2026, godz. 19:00/);
  });

  it("podpis udostępniającego ZOSTAJE — bywa jedyną treścią", () => {
    assert.match(text, /Rezerwuj stolik na wyjątkowy Wieczór Grecki/);
  });

  it("nagłówek mówi modelowi, czyja to treść i z kiedy", () => {
    assert.match(text, new RegExp(`${SHARED_LABEL} \\(Hotel HP Park Poznań, 2026-08-03`));
  });

  it("oryginał bez treści nie dokłada pustego nagłówka", () => {
    const pusty = fbGroupPostsToText([{ ...wlasny, original_post: { post_id: "x", content: "" } }]);
    assert.doesNotMatch(pusty, new RegExp(SHARED_LABEL));
  });
});

describe("dowód dla bezpiecznika obejmuje oryginał, ale nie jego nagłówek", () => {
  const posts = postsByLink(fbGroupPostsToText([grecki]));
  const dowod = posts.get(POST_URL.replace(/\/$/, ""))!;

  it("termin z oryginału ratuje wydarzenie przed odsiewem", () => {
    assert.equal(hasDateHint(dowod), true);
  });

  /**
   * Nagłówek niesie datę PUBLIKACJI oryginału. Gdyby liczył się jako termin, bezpiecznik
   * przepuszczałby każde udostępnienie — czyli 43% postów — bez względu na treść.
   */
  it("sama data publikacji oryginału terminem nie jest", () => {
    const bezTresci = postsByLink(fbGroupPostsToText([
      { ...grecki, content: "Polecam!", original_post: { ...grecki.original_post, content: "Zapraszamy 🇬🇷" } },
    ]));
    assert.equal(hasDateHint(bezTresci.get(POST_URL.replace(/\/$/, ""))!), false);
  });
});

describe("fbOriginsByPost — wiązanie wydarzenia z oryginałem", () => {
  it("mapuje adres postu (bez końcowego ukośnika) na tożsamość oryginału", () => {
    const m = fbOriginsByPost([grecki, wlasny]);
    assert.equal(m.size, 1);
    assert.deepEqual(m.get(POST_URL.replace(/\/$/, "")), {
      key: ORIG_ID, url: "https://www.facebook.com/reel/2155526571657733/",
    });
  });
});
