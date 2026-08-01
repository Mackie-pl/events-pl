/**
 * Regresja usterki, która przez cały lipiec 2026 trzymała w rejestrze sześć nieistniejących domen.
 *
 * `verifySource` przy braku klucza wyszukiwarki kończył `outcome: "error"` i NIE dotykał
 * `src.dead` — bo naprawy „nie próbowano". Dla 404 to słuszna ostrożność (serwer żyje, może
 * wrócić), ale dla domeny, która nie rozwiązuje się w DNS, nie ma czego potwierdzać: adres jest
 * martwy niezależnie od tego, czy mamy czym szukać następcy. Skutkiem było sześć źródeł
 * odpytywanych przez `daily` codziennie, bez końca i bez szans na powodzenie.
 *
 * Test podstawia `fetch`, więc nie rusza sieci ani modelu.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { rebase, verifySource } from "../src/pipeline/verify/verify-source.js";
import { resetSearchState } from "../src/adapters/search.js";
import type { Source } from "../src/types/index.js";

const source = (over: Partial<Source> = {}): Source => ({
  id: "gok-test", name: "GOK Testowy", type: "culture_center",
  url: "https://goksokol.pl/", town: "Czerwonak", fetch: "plain", verified: true, ...over,
});

const realFetch = globalThis.fetch;

/** Odpowiedzi per host+ścieżka; brak wpisu = błąd sieciowy o podanej treści. */
function stubNetwork(routes: Record<string, { status: number; body: string }>, netErr = "getaddrinfo ENOTFOUND"): void {
  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url];
    if (!hit) return Promise.reject(new TypeError(`fetch failed ← ${netErr} ${new URL(url).host}`));
    return Promise.resolve(new Response(hit.body, { status: hit.status, headers: { "content-type": "text/html" } }));
  };
}

const PAGE = `<html><body>${"treść strony ".repeat(60)}</body></html>`;

beforeEach(() => {
  resetSearchState();
  delete process.env["GOOGLE_API_KEY"];
  delete process.env["GOOGLE_CSE_CX"];
  delete process.env["BRAVE_API_KEY"];
  process.env["ENTRYPOINT_LLM"] = "never"; // profil bez modelu — test ma być darmowy
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["ENTRYPOINT_LLM"];
});

describe("verifySource — domena nie do uratowania", () => {
  it("ENOTFOUND na wszystkich wariantach oznacza źródło jako dead MIMO braku wyszukiwarki", async () => {
    stubNetwork({});
    const src = source();
    const ver = await verifySource(src, false);

    assert.equal(ver.reach, "dns-dead");
    assert.equal(ver.outcome, "dead");
    // to jest sedno regresji: bez tego daily dobija się do martwej domeny codziennie
    assert.equal(src.dead, true);
    assert.equal(src.verified, false);
    assert.match(src.notes ?? "", /martwy URL/);
  });

  it("drabina przechodzi warianty, zanim uzna domenę za martwą", async () => {
    stubNetwork({});
    const ver = await verifySource(source(), false);
    // https → http → www → http+www: cztery szczeble, wszystkie w śladzie
    assert.ok((ver.ladder?.length ?? 0) >= 4, `oczekiwano ≥4 szczebli, było ${ver.ladder?.length}`);
    assert.ok(ver.ladder?.every((s) => s.outcome === "dns-dead"));
  });
});

describe("verifySource — serwis żyje pod innym adresem", () => {
  it("wygasły certyfikat: schodzi na http i zapisuje naprawę, nie zabija źródła", async () => {
    stubNetwork({ "http://kok.kornik.pl/": { status: 200, body: PAGE } }, "certificate has expired");
    const src = source({ id: "kornik-kok", url: "https://kok.kornik.pl/" });
    const ver = await verifySource(src, false);

    assert.equal(ver.outcome, "fixed");
    assert.equal(src.url, "http://kok.kornik.pl/");
    assert.equal(src.dead, undefined);
    assert.equal(src.verified, true);
    // stary adres zostaje w historii — inaczej nie da się później odtworzyć, co się zmieniło
    assert.deepEqual(src.previous_urls, ["https://kok.kornik.pl/"]);
  });
});

describe("verifySource — serwer odpowiada, zasobu brak", () => {
  it("404 bez wyszukiwarki to `error`, NIE `dead` — serwis może wrócić", async () => {
    stubNetwork({
      "https://ckzamek.pl/wydarzenia/": { status: 404, body: "nie ma" },
      "http://ckzamek.pl/wydarzenia/": { status: 404, body: "nie ma" },
      "https://www.ckzamek.pl/wydarzenia/": { status: 404, body: "nie ma" },
      "http://www.ckzamek.pl/wydarzenia/": { status: 404, body: "nie ma" },
    });
    const src = source({ id: "ck-zamek", url: "https://ckzamek.pl/wydarzenia/" });
    const ver = await verifySource(src, false);

    assert.equal(ver.reach, "http-error");
    assert.equal(ver.outcome, "error");
    assert.equal(src.dead, undefined, "404 to nie to samo co nieistniejąca domena");
    assert.match(ver.err ?? "", /naprawa pominięta/);
  });
});

describe("rebase — naprawa adresu nie może skasować paginacji", () => {
  it("przenosi nowy origin do szablonu z {page}", () => {
    assert.equal(
      rebase("https://www.mosina.pl/wydarzenia?page={page}", "http://www.mosina.pl/wydarzenia?page=1",
        "https://www.mosina.pl/wydarzenia?page=1"),
      "http://www.mosina.pl/wydarzenia?page={page}",
    );
  });

  it("gdy zmieniła się ścieżka, bierze adres, który faktycznie odpowiedział", () => {
    assert.equal(
      rebase("https://x.pl/stare?page={page}", "https://x.pl/nowe", "https://x.pl/stare?page=1"),
      "https://x.pl/nowe",
    );
  });

  it("brak zmiany adresu zostawia szablon nietknięty", () => {
    assert.equal(rebase("https://x.pl/a?p={page}", "https://x.pl/a?p=1", "https://x.pl/a?p=1"),
      "https://x.pl/a?p={page}");
  });
});

describe("weto modelu nie może kasować sprawdzonego źródła", () => {
  // Regresja z pierwszego przebiegu profilera: model zawetował `swarzedz-city`, które
  // w ostatnim `daily` dało 10 wydarzeń, a `poznan-city-api` (SOAP WSDL) w ogóle nie ma
  // HTML-owej listy, więc odpowiedź „nie widzę wydarzeń" była tam gwarantowana.
  const veto = async (src: Source, isNew: boolean) => {
    stubNetwork({ [src.url]: { status: 200, body: PAGE } });
    // ENTRYPOINT_LLM=never nie wywoła modelu, więc werdykt wstrzykujemy przez profil:
    // testujemy REGUŁĘ (kto wygrywa przy sprzeczności), nie samą odpowiedź modelu
    process.env["ENTRYPOINT_LLM"] = "never";
    return verifySource(src, isNew);
  };

  it("źródło typu api nie jest w ogóle pytane o entrypoint", async () => {
    const src = source({ id: "poznan-city-api", url: "https://www.um.poznan.pl/ws?wsdl", type: "api", fetch: "api" });
    const ver = await veto(src, false);
    assert.equal(ver.verdict, undefined, "WSDL nie ma listy wydarzeń — pytanie o nią nie ma sensu");
    assert.equal(src.dead, undefined);
    assert.equal(ver.outcome, "ok");
  });

  it("istniejące źródło przeżywa werdykt none — rozstrzyga plon w daily", async () => {
    const src = source({ id: "swarzedz-city", url: "https://www.swarzedz.pl/", type: "city_portal" });
    const ver = await veto(src, false);
    assert.equal(src.dead, undefined, "10 wydarzeń dziennie waży więcej niż jedno spojrzenie modelu");
    assert.notEqual(ver.outcome, "dead");
  });
});

describe("weto plonu — źródło, które daje wydarzenia, nie może umrzeć", () => {
  // Spirala, którą to zamyka: `daily` pobiera stronę pełnym potokiem, weryfikacja sondą.
  // Gdy sonda przegrywa tam, gdzie potok wygrywa, źródło dostaje `dead:true`, daily przestaje
  // je odpytywać (skipped-dead) i jedyny dowód, że żyło, przestaje powstawać.
  it("ENOTFOUND nie zabija źródła, które plonowało w oknie runs.json", async () => {
    stubNetwork({});
    const src = source();
    const ver = await verifySource(src, false, 39);

    assert.equal(ver.reach, "dns-dead");
    assert.equal(src.dead, undefined, "39 wydarzeń w tygodniu waży więcej niż nieudana sonda");
    assert.equal(ver.outcome, "error", "zostaje do ponownego sprawdzenia, nie do pochówku");
    assert.match(ver.note ?? "", /39 wydarzeń/);
  });

  it("zerowy plon nie blokuje werdyktu dead", async () => {
    stubNetwork({});
    const src = source();
    const ver = await verifySource(src, false, 0);

    assert.equal(ver.outcome, "dead");
    assert.equal(src.dead, true);
  });
});

describe("verifySource — Facebook", () => {
  it("adresy FB są pomijane bez dotykania rejestru", async () => {
    stubNetwork({});
    const src = source({ id: "fb", url: "https://www.facebook.com/DKStokrotka/", fetch: "fb" });
    const ver = await verifySource(src, false);
    assert.equal(ver.outcome, "skipped");
    assert.equal(src.dead, undefined);
    assert.equal(src.checked, undefined);
  });
});
