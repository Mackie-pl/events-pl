/**
 * Drabina osiągalności — klasyfikacja objawów i warianty adresu.
 *
 * Testy odpowiadają jeden do jednego stanom, które w lipcu 2026 zablokowały rejestr:
 * wygasły certyfikat i 403 były zapisywane tak samo jak nieistniejąca domena, więc
 * dwa żywe serwisy szły do naprawy razem z sześcioma martwymi.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { classify, variants } from "../src/pipeline/verify/reach.js";
import type { FetchProbe } from "../src/types/index.js";

const probe = (over: Partial<FetchProbe> = {}): FetchProbe =>
  ({ at: "2026-07-30T06:00:00.000Z", url: "https://x.pl/", ok: false, ms: 12, ...over });

describe("classify", () => {
  it("200 to ok, a 200 pod innym adresem to przekierowanie", () => {
    assert.equal(classify(probe({ ok: true, httpStatus: 200 })), "ok");
    assert.equal(classify(probe({ ok: true, httpStatus: 200, finalUrl: "https://x.pl/nowa" })), "redirected");
  });

  it("403 i 429 to anty-bot, nie martwy adres", () => {
    // www.suchylas.pl: 403 dla nagłówków bota, 200 dla przeglądarki
    assert.equal(classify(probe({ httpStatus: 403, err: "HTTP 403" })), "anti-bot");
    assert.equal(classify(probe({ httpStatus: 429, err: "HTTP 429" })), "anti-bot");
  });

  it("wygasły certyfikat to osobny objaw — serwer istnieje", () => {
    // kok.kornik.pl: https odrzucone przez TLS, http odpowiada
    assert.equal(classify(probe({ err: "fetch failed ← certificate has expired" })), "cert");
  });

  it("ENOTFOUND to dns-dead — jedyny objaw nie do naprawienia", () => {
    assert.equal(classify(probe({ err: "getaddrinfo ENOTFOUND goksokol.pl" })), "dns-dead");
    assert.equal(classify(probe({ err: "getaddrinfo EAI_AGAIN x.pl" })), "dns-dead");
  });

  it("404/500 to http-error — serwer żyje, zasobu nie ma", () => {
    assert.equal(classify(probe({ httpStatus: 404, err: "HTTP 404" })), "http-error");
    assert.equal(classify(probe({ httpStatus: 500, err: "HTTP 500" })), "http-error");
  });

  it("200 z pustą treścią to zaślepka, nie sukces", () => {
    assert.equal(classify(probe({ err: "podejrzanie krótka odpowiedź (120 B)" })), "placeholder");
  });

  it("status ma pierwszeństwo przed treścią błędu", () => {
    // komunikat bywa zlepkiem („HTTP 403 ← certificate…") — decyduje kod, bo jest jednoznaczny
    assert.equal(classify(probe({ httpStatus: 403, err: "HTTP 403 ← certificate has expired" })), "anti-bot");
  });
});

describe("variants", () => {
  it("proponuje zamianę schematu przed zamianą www", () => {
    // kolejność ma znaczenie: wygasły certyfikat jest częstszy niż brak rekordu dla www
    assert.deepEqual(variants("https://kok.kornik.pl/"), [
      "http://kok.kornik.pl/",
      "https://www.kok.kornik.pl/",
      "http://www.kok.kornik.pl/",
    ]);
  });

  it("dla adresu z www proponuje wersję bez www", () => {
    assert.ok(variants("https://www.x.pl/").includes("https://x.pl/"));
  });

  it("adres nie do sparsowania nie wywraca drabiny", () => {
    assert.deepEqual(variants("nie-adres"), []);
  });
});
