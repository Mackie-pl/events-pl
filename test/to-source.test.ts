/**
 * toSource jest jedyną barierą między halucynacją modelu a rejestrem czytanym codziennie
 * przez daily. Poprzednia wersja robiła `as Source[]` — stąd tu nacisk na odrzucenia
 * i na listę `fixes`, bo to ona ląduje w raporcie jako uzasadnienie zmiany.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { toSource } from "../src/pipeline/discover/to-source.js";

const ok = (raw: unknown, town = "Poznań") => {
  const r = toSource(raw, town);
  assert.ok(!("err" in r), `spodziewano się sukcesu, dostano: ${"err" in r ? r.err : ""}`);
  return r;
};
const err = (raw: unknown, town = "Poznań"): string => {
  const r = toSource(raw, town);
  assert.ok("err" in r, "spodziewano się odrzucenia");
  return r.err;
};

describe("toSource — odrzucenia", () => {
  it("odrzuca nie-obiekty", () => {
    for (const v of [null, "x", 42, undefined]) assert.match(err(v), /nie jest obiektem/);
  });

  it("wymaga url i name", () => {
    assert.match(err({ name: "A" }), /brak pola url/);
    assert.match(err({ url: "https://a.pl" }), /brak pola name/);
  });

  it("odrzuca url, który nie jest adresem", () => {
    assert.match(err({ url: "zobacz w google", name: "A" }), /nie jest adresem/);
    assert.match(err({ url: "ftp://x", name: "A" }), /nie jest adresem/);
  });

  it("odrzuca, gdy nie da się zbudować id", () => {
    assert.match(err({ url: "https://a.pl", name: "???", id: "!!!" }, "!!!"), /nie da się zbudować id/);
  });
});

describe("toSource — naprawy zapisane w `fixes`", () => {
  it("dokleja brakujący schemat", () => {
    const r = ok({ url: "gok.lubon.pl", name: "GOK", fetch: "plain", type: "culture_center" });
    assert.equal(r.src.url, "https://gok.lubon.pl");
    assert.deepEqual(r.fixes, ["dodano schemat https://"]);
  });

  it("brak fetch/type to też naprawa — model pominął pola, my je uzupełniamy", () => {
    const r = ok({ url: "https://a.pl", name: "A" });
    assert.deepEqual(r.fixes, ['nieznane fetch "" → "plain"', 'nieznany type "" → "venue"']);
  });

  it("skraca URL grupy FB do korzenia i wymusza fetch/type", () => {
    const r = ok({ url: "https://www.facebook.com/groups/poznan123/posts/9/?ref=x", name: "Grupa" });
    assert.equal(r.src.url, "https://www.facebook.com/groups/poznan123");
    assert.equal(r.src.fetch, "fb_group");
    assert.equal(r.src.type, "fb_group");
    assert.equal(r.fixes.length, 3);
  });

  it("zwykły adres facebook.com dostaje fetch:fb", () => {
    const r = ok({ url: "https://www.facebook.com/DomKultury", name: "DK", fetch: "plain" });
    assert.equal(r.src.fetch, "fb");
  });

  it("nieznane fetch/type spadają na wartości domyślne", () => {
    const r = ok({ url: "https://a.pl", name: "A", fetch: "magia", type: "cokolwiek" });
    assert.equal(r.src.fetch, "plain");
    assert.equal(r.src.type, "venue");
    assert.equal(r.fixes.length, 2);
  });

  it("poprawny rekord nie generuje żadnych napraw", () => {
    const r = ok({ url: "https://a.pl", name: "A", fetch: "plain", type: "library" });
    assert.deepEqual(r.fixes, []);
  });
});

describe("toSource — pola wynikowe", () => {
  it("buduje id ze slug(gmina-nazwa), gdy model go nie podał", () => {
    assert.equal(ok({ url: "https://a.pl", name: "Dom Kultury Łódź" }, "Luboń").src.id,
      "lubon-dom-kultury-lodz");
  });

  it("placeholder paginacji nie psuje walidacji URL-a", () => {
    assert.equal(ok({ url: "https://a.pl/list?p={page}", name: "A" }).src.url, "https://a.pl/list?p={page}");
  });

  it("przycina confidence do [0,1], a bez liczby pomija pole", () => {
    assert.equal(ok({ url: "https://a.pl", name: "A", confidence: 1.7 }).src.confidence, 1);
    assert.equal(ok({ url: "https://a.pl", name: "A", confidence: -3 }).src.confidence, 0);
    assert.equal(ok({ url: "https://a.pl", name: "A", confidence: "wysoka" }).src.confidence, undefined);
    assert.equal(ok({ url: "https://a.pl", name: "A" }).src.confidence, undefined);
  });

  it("gmina z rekordu wygrywa z gminą przebiegu", () => {
    assert.equal(ok({ url: "https://a.pl", name: "A", town: "Mosina" }, "Poznań").src.town, "Mosina");
    assert.equal(ok({ url: "https://a.pl", name: "A" }, "Poznań").src.town, "Poznań");
  });

  it("nowe źródło startuje jako niezweryfikowane i oznaczone jako auto", () => {
    const { src } = ok({ url: "https://a.pl", name: "A" });
    assert.equal(src.verified, false);
    assert.equal(src.discovered, "auto");
  });
});
