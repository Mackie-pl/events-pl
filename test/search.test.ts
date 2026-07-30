/**
 * Wyszukiwarka: rozróżnienie „brak wyników" od „limit wyczerpany".
 *
 * To jest ta sama usterka, którą Brave miał na początku i którą opisuje komentarz w
 * `google-cse.ts`: wyczerpany limit odpowiadał tak, że w raporcie wyglądał identycznie jak
 * gmina bez źródeł. U Google powód siedzi w CIELE odpowiedzi (`error.errors[].reason`),
 * a status 403 znaczy zarówno „zły klucz", jak i „koniec limitu" — bez czytania ciała
 * nie da się ich rozdzielić, a to dwie zupełnie różne naprawy.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { readError, search } from "../src/adapters/google-cse.js";
import { readError as serperError, search as serperSearch } from "../src/adapters/serper.js";
import type { SearchCall } from "../src/types/index.js";

const call = (): SearchCall => ({ query: "gok wydarzenia", results: [], ms: 0 });

const QUOTA_403 = JSON.stringify({
  error: {
    code: 403,
    message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'",
    errors: [{ reason: "dailyLimitExceeded", domain: "usageLimits" }],
  },
});

const realFetch = globalThis.fetch;
const stubFetch = (status: number, body: string): void => {
  globalThis.fetch = () =>
    Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
};

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["GOOGLE_API_KEY"];
  delete process.env["GOOGLE_CSE_CX"];
  delete process.env["SERPER_API_KEY"];
});

describe("serper (dostawca domyślny)", () => {
  it("mapuje `organic` na kształt rejestru", async () => {
    process.env["SERPER_API_KEY"] = "k";
    stubFetch(200, JSON.stringify({
      organic: [{ title: "GOKiS Kleszczewo", link: "https://gokis.kleszczewo.pl/", snippet: "Kalendarz" }],
      credits: 1,
    }));
    const c = call();
    const out = await serperSearch("gokis kleszczewo", c);
    assert.deepEqual(out.results, [
      { title: "GOKiS Kleszczewo", url: "https://gokis.kleszczewo.pl/", desc: "Kalendarz" },
    ]);
    assert.equal(out.fatal, undefined);
  });

  it("klucz idzie NAGŁÓWKIEM, nie w URL-u — discover-runs.json trafia do publicznego repo", async () => {
    process.env["SERPER_API_KEY"] = "sekretny-klucz";
    let seenUrl = "";
    let seenKey: string | null = null;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenKey = new Headers(init?.headers).get("X-API-KEY");
      return Promise.resolve(new Response(JSON.stringify({ organic: [] }), { status: 200 }));
    };
    await serperSearch("cokolwiek", call());
    assert.equal(seenKey, "sekretny-klucz");
    assert.ok(!seenUrl.includes("sekretny-klucz"), `klucz wyciekł do URL-a: ${seenUrl}`);
  });

  it("wyczerpane kredyty (402) wyłączają wyszukiwarkę", async () => {
    process.env["SERPER_API_KEY"] = "k";
    stubFetch(402, JSON.stringify({ message: "Not enough credits" }));
    const out = await serperSearch("x", call());
    assert.match(out.fatal ?? "", /402/);
    assert.match(out.fatal ?? "", /Not enough credits/);
  });

  it("odrzucony klucz (403) też jest błędem trwałym", async () => {
    process.env["SERPER_API_KEY"] = "zly";
    stubFetch(403, JSON.stringify({ message: "Unauthorized." }));
    const c = call();
    const out = await serperSearch("x", c);
    assert.equal(c.httpStatus, 403);
    assert.match(out.fatal ?? "", /Unauthorized/);
  });

  it("500 to potknięcie, nie koniec przebiegu", async () => {
    process.env["SERPER_API_KEY"] = "k";
    stubFetch(500, "<html>Bad Gateway</html>");
    const out = await serperSearch("x", call());
    assert.deepEqual(out.results, []);
    assert.equal(out.fatal, undefined, "pojedynczy błąd serwera nie może zabić całego discovery");
  });

  it("brak klucza to `fatal`, nie ciche zero", async () => {
    const out = await serperSearch("x", call());
    assert.match(out.fatal ?? "", /SERPER_API_KEY/);
  });

  it("readError radzi sobie z odpowiedzią nie-JSON", () => {
    assert.match(serperError("<html>502</html>"), /502/);
    assert.equal(serperError(JSON.stringify({ message: "Unauthorized." })), "Unauthorized.");
  });
});

describe("readError", () => {
  it("wyciąga reason i komunikat z ciała odpowiedzi", () => {
    const { reason, message } = readError(QUOTA_403);
    assert.equal(reason, "dailyLimitExceeded");
    assert.match(message, /Quota exceeded/);
  });

  it("odpowiedź nie-JSON nie wywraca odczytu", () => {
    const { reason, message } = readError("<html>502 Bad Gateway</html>");
    assert.equal(reason, "");
    assert.match(message, /502/);
  });
});

describe("search", () => {
  it("wyczerpany limit dzienny WYŁĄCZA wyszukiwarkę, a nie udaje zera wyników", () => {
    process.env["GOOGLE_API_KEY"] = "k";
    process.env["GOOGLE_CSE_CX"] = "cx";
    stubFetch(403, QUOTA_403);
    return search("gok wydarzenia", call()).then((out) => {
      assert.deepEqual(out.results, []);
      assert.ok(out.fatal, "limit musi ustawić `fatal` — bez tego lecą kolejne 200 zapytań na pewny błąd");
      assert.match(out.fatal, /403/);
    });
  });

  it("zapisuje powód błędu w śladzie przebiegu", async () => {
    process.env["GOOGLE_API_KEY"] = "k";
    process.env["GOOGLE_CSE_CX"] = "cx";
    stubFetch(403, QUOTA_403);
    const c = call();
    await search("x", c);
    assert.equal(c.httpStatus, 403);
    assert.match(c.err ?? "", /dailyLimitExceeded/);
  });

  it("brak konfiguracji to `fatal`, nie cichy brak wyników", async () => {
    const out = await search("x", call());
    assert.match(out.fatal ?? "", /GOOGLE_API_KEY/);
  });

  it("brak samego cx też jest rozpoznawany osobno", async () => {
    process.env["GOOGLE_API_KEY"] = "k";
    const out = await search("x", call());
    assert.match(out.fatal ?? "", /GOOGLE_CSE_CX/);
  });

  it("200 bez `items` to naprawdę brak wyników — bez wyłączania wyszukiwarki", async () => {
    process.env["GOOGLE_API_KEY"] = "k";
    process.env["GOOGLE_CSE_CX"] = "cx";
    stubFetch(200, JSON.stringify({ searchInformation: { totalResults: "0" } }));
    const out = await search("x", call());
    assert.deepEqual(out.results, []);
    assert.equal(out.fatal, undefined);
  });

  it("mapuje wyniki na kształt rejestru (link → url, snippet → desc)", async () => {
    process.env["GOOGLE_API_KEY"] = "k";
    process.env["GOOGLE_CSE_CX"] = "cx";
    stubFetch(200, JSON.stringify({
      items: [{ title: "GOK Komorniki", link: "https://gokkomorniki.pl/", snippet: "Kalendarz imprez" }],
    }));
    const c = call();
    const out = await search("x", c);
    assert.deepEqual(out.results, [
      { title: "GOK Komorniki", url: "https://gokkomorniki.pl/", desc: "Kalendarz imprez" },
    ]);
    assert.equal(c.results.length, 1);
  });
});
