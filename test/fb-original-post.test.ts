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
import {
  SHARED_LABEL, fbGroupPostsToBlocks, fbGroupPostsToText, fbOriginal, fbOriginsByPost,
  fbShareShape, fbShareStats,
} from "../src/pipeline/facebook.js";
import { urlKey } from "../src/shared/url.js";

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

/**
 * Wklejone ogłoszenie: podpis udostępniającego nie jest komentarzem, tylko kopią oryginału.
 *
 * Rekordy niżej to okrojone kopie PRAWDZIWYCH postów z 2026-08-14/15 (poznańskie grupy):
 * raz podpis jest początkiem oryginału (BitterSweet), raz całością bez emoji i śródtytułu
 * (Galeria Lalek). Pomiar na archiwum 2026-08-15: 42 z 75 udostępnień z treścią oryginału
 * mówiło to samo dwa razy — 12 959 z 18 777 znaków podpisów.
 */
const bitterSweet = {
  url: "https://www.facebook.com/groups/241900542530749/posts/27756479087312857/",
  content: "BitterSweet Festiwal na poznańskiej Cytadeli (13-15 sierpnia) – dodatkowa linia nr 30\n"
    + "Obowiązuje 13.08.2026 - 16.08.2026",
  date_posted: "2026-08-14T10:00:04.000Z",
  original_post: {
    post_id: "orig-bittersweet",
    post_url: "https://www.facebook.com/plotkarski/posts/1/",
    user_name: "Magazyn Plotkarski Poznań",
    date: "2026-08-13T19:45:44.000Z",
    content: "BitterSweet Festiwal na poznańskiej Cytadeli (13-15 sierpnia) – dodatkowa linia nr 30\n"
      + "Obowiązuje 13.08.2026 - 16.08.2026\n"
      + "Linia nr 30 kursuje w godzinach 15:00 – 2:30, co 10 minut.",
  },
};

/** Podpis = oryginał, różnica wyłącznie w ozdobnikach i śródtytule nad nim. */
const galeria = {
  url: "https://www.facebook.com/groups/241900542530749/posts/27756452287315537/",
  content: "Zapraszamy na bezpłatne zwiedzanie Galerii Lalek.\n"
    + "Galeria czynna jest codziennie od 10.00 do 18.00.",
  date_posted: "2026-08-14T08:00:01.000Z",
  original_post: {
    post_id: "orig-galeria",
    post_url: "https://www.facebook.com/plotkarski/posts/2/",
    user_name: "Magazyn Plotkarski Poznań",
    date: "2026-02-26T20:26:56.000Z",
    content: "TEATR ANIMACJI GALERIA LALEK\n"
      + "Zapraszamy na bezpłatne zwiedzanie Galerii Lalek.\n"
      + "🕙Galeria czynna jest codziennie od 10.00 do 18.00.",
  },
};

/** Odwrotnie: udostępniający dopisał coś od siebie DO wklejonego ogłoszenia. */
const zDopiskiem = {
  url: "https://www.facebook.com/groups/241900542530749/posts/33/",
  content: "Byliśmy, polecamy!\nKoncert w sobotę 16 sierpnia o 19:00 w parku.",
  date_posted: "2026-08-14T09:00:00.000Z",
  original_post: {
    post_id: "orig-koncert",
    post_url: "https://www.facebook.com/dk/posts/3/",
    user_name: "Dom Kultury",
    date: "2026-08-12T09:00:00.000Z",
    content: "Koncert w sobotę 16 sierpnia o 19:00 w parku.",
  },
};

describe("fbShareShape — która strona postu jest nadzbiorem", () => {
  it("podpis wklejony z oryginału: zostaje oryginał", () => {
    assert.equal(fbShareShape(bitterSweet.content, bitterSweet.original_post.content), "sam oryginał");
  });

  it("ozdobniki i śródtytuł nie robią z kopii osobnej treści", () => {
    assert.equal(fbShareShape(galeria.content, galeria.original_post.content), "sam oryginał");
  });

  it("oryginał w całości zawarty w podpisie: zostaje podpis", () => {
    assert.equal(fbShareShape(zDopiskiem.content, zDopiskiem.original_post.content), "sam podpis");
  });

  it("własny komentarz udostępniającego to osobna treść", () => {
    assert.equal(fbShareShape(grecki.content, grecki.original_post.content), "podpis+oryginał");
  });
});

describe("fbGroupPostsToBlocks — każda treść raz", () => {
  it("wklejony podpis nie jedzie do modelu obok oryginału", () => {
    const blok = fbGroupPostsToBlocks([bitterSweet])[0]!;
    assert.equal(blok.match(/Obowiązuje 13\.08\.2026/g)?.length, 1);
    // pełne ogłoszenie zostaje — z niego pochodzą godziny kursowania
    assert.match(blok, /co 10 minut/);
    assert.match(blok, new RegExp(SHARED_LABEL));
  });

  it("gdy oryginał nic nie dokłada, znika razem z nagłówkiem", () => {
    const blok = fbGroupPostsToBlocks([zDopiskiem])[0]!;
    assert.equal(blok.match(/Koncert w sobotę 16 sierpnia/g)?.length, 1);
    assert.match(blok, /Byliśmy, polecamy!/);
    assert.doesNotMatch(blok, new RegExp(SHARED_LABEL));
  });

  it("podpis naprawdę własny nadal jedzie razem z oryginałem", () => {
    const blok = fbGroupPostsToBlocks([grecki])[0]!;
    assert.match(blok, /Rezerwuj stolik/);
    assert.match(blok, /21 sierpnia 2026, godz. 19:00/);
  });

  /**
   * Odsiew nie może zjeść dowodu na termin — to on trzyma wydarzenie przy życiu
   * (extract/date-hint.ts). Przy wklejonym podpisie termin zostaje po stronie oryginału.
   */
  it("termin przeżywa odsiew po obu stronach", () => {
    for (const rec of [bitterSweet, galeria, zDopiskiem]) {
      const dowod = postsByLink(fbGroupPostsToText([rec])).get(urlKey(rec.url))!;
      assert.equal(hasDateHint(dowod), true, `dowód bez terminu dla ${rec.url}`);
    }
  });
});

/**
 * Udostępnienie BEZ własnego podpisu — najczęstszy kształt tego, co potok do 2026-08-20
 * uznawał za wiersz błędu scrapera i wyrzucał przed modelem (32 z 169 opłaconych rekordów
 * jednego przebiegu). Rekord przycięty z prawdziwej migawki `fb-group-kultura-komorniki`
 * (2026-08-20): udostępniony reel szkoły, w poście ani jednego znaku od udostępniającego.
 */
describe("udostępnienie bez podpisu — cała treść po stronie oryginału", () => {
  const bezPodpisu = {
    url: "https://www.facebook.com/groups/kulturakomorniki/posts/2457310234790113/",
    date_posted: "2026-08-19T14:25:02.000Z",
    original_post: {
      post_id: "UzpfSTEwMDA5MDY3NTA1NDExODoxMDExMDkzMTkxOTIzMTczOjEwMTEwOTMxOTE5MjMxNzM=",
      post_url: "https://www.facebook.com/reel/1577612957360299/",
      user_name: "Szkoła Podstawowa Popatrz Szerzej w Komornikach",
      date: "2026-08-19T14:24:23.000Z",
      content: "W ostatnim tygodniu sierpnia zapraszamy na półkolonie, podczas których"
        + " sprawdzimy, jak działa człowiek.",
    },
  };

  it("post trafia do modelu — z nagłówkiem oryginału i jego treścią", () => {
    const blok = fbGroupPostsToBlocks([bezPodpisu])[0];
    assert.ok(blok, "post bez podpisu nie może zniknąć przed modelem");
    assert.match(blok, new RegExp(SHARED_LABEL));
    assert.equal(blok.match(/półkolonie/g)?.length, 1, "treść raz, bez podpisu do powtórzenia");
    assert.match(blok, /LINK: https:\/\/www\.facebook\.com\/groups\/kulturakomorniki/);
  });

  it("wiąże się z oryginałem tak samo jak udostępnienie z podpisem", () => {
    const o = fbOriginsByPost([bezPodpisu]).get(urlKey(bezPodpisu.url));
    assert.equal(o?.url, "https://www.facebook.com/reel/1577612957360299/");
  });

  it("nie liczy się do odsiewu powtórzeń — nie ma dwóch stron do porównania", () => {
    assert.equal(fbShareStats([bezPodpisu]).shares, 0);
  });
});

describe("fbShareStats — ślad odsiewu", () => {
  it("liczy strony postu i zaoszczędzone znaki", () => {
    const s = fbShareStats([bitterSweet, galeria, zDopiskiem, grecki, wlasny]);
    assert.equal(s.shares, 4);
    assert.equal(s.onlyOriginal, 2);
    assert.equal(s.onlyCaption, 1);
    assert.equal(s.both, 1);
    assert.equal(
      s.charsSaved,
      bitterSweet.content.length + galeria.content.length + zDopiskiem.original_post.content.length,
    );
  });

  it("oryginał bez treści nie jest udostępnieniem do porównania", () => {
    const s = fbShareStats([{ ...wlasny, original_post: { post_id: "x", content: "" } }]);
    assert.equal(s.shares, 0);
  });
});

describe("dowód dla bezpiecznika obejmuje oryginał, ale nie jego nagłówek", () => {
  const posts = postsByLink(fbGroupPostsToText([grecki]));
  const dowod = posts.get(urlKey(POST_URL))!;

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
    assert.equal(hasDateHint(bezTresci.get(urlKey(POST_URL))!), false);
  });
});

/**
 * Wiązanie „post → oryginał" pęka CICHO: gdy klucz mapy i klucz wyszukania rozjadą się
 * o `www.`, końcowy ukośnik albo schemat, `origin` po prostu się nie dopisze. Bez błędu,
 * bez kroku w śladzie — dedupe po oryginale przestanie działać i nikt tego nie zauważy.
 * Dlatego oba końce liczy `urlKey` i dlatego stoi tu test, a nie komentarz.
 */
describe("fbOriginsByPost — wiązanie wydarzenia z oryginałem", () => {
  it("mapuje adres postu na tożsamość oryginału", () => {
    const m = fbOriginsByPost([grecki, wlasny]);
    assert.equal(m.size, 1);
    assert.deepEqual(m.get(urlKey(POST_URL)), {
      key: ORIG_ID, url: "https://www.facebook.com/reel/2155526571657733/",
    });
  });

  it("adres przepisany przez model trafia w ten sam klucz", () => {
    const m = fbOriginsByPost([grecki]);
    // tak model bywa przepisuje „LINK:" do source_url — każda z tych postaci ma znaleźć
    // oryginał, bo w events.json ląduje to, co napisał model, nie to, co stało w rekordzie
    for (const variant of [
      POST_URL,
      POST_URL.replace(/\/$/, ""),
      POST_URL.replace("https://", "http://"),
      POST_URL.replace("www.", ""),
    ]) {
      assert.ok(m.get(urlKey(variant)), `nie znalazł oryginału dla „${variant}"`);
    }
  });

  /**
   * GRANICA, świadoma: `urlKey` zachowuje parametry, bo w rejestrze źródeł `?page=2` to
   * inna strona. Model dokleja `?ref=…` do adresu rzadko (w materiale z 2026-08-14 ani razu),
   * a rozluźnianie normalizacji dla wszystkich jej użytkowników kosztowałoby więcej.
   */
  it("parametr w adresie daje inny klucz — i tak ma zostać", () => {
    const m = fbOriginsByPost([grecki]);
    assert.equal(m.get(urlKey(`${POST_URL}?ref=share`)), undefined);
  });
});
