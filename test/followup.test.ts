/**
 * Followupy — trzy warstwy odsiewu i ścieżka blokowa.
 *
 * Do 2026-08 followupy były jedynym miejscem w potoku, które płaciło pełną stawkę za całą
 * stronę: bloki obsługiwały KAŻDĄ stronę źródła, a obok stało 20 wywołań na całość po
 * 264 789 znaków — co do jednego followupy (przebieg 2026-08-12). Do tego ich cache stał
 * pod SUROWYM adresem, więc `www.x/y` i `x/y` to były dwa pobrania i dwa wywołania modelu.
 *
 * Wyrocznią na „model nie został wywołany" jest tu licznik żądań do OpenRoutera: gdyby
 * którakolwiek warstwa przepuściła, atrapa sieci zwróciłaby błąd i `outcome` byłby `error`,
 * a nie to, czego oczekujemy. Test nie rusza ani sieci, ani modelu.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { toText } from "../src/adapters/page-fetch.js";
import { suppressArchive } from "../src/adapters/supabase-archive.js";
import { segmentHtml } from "../src/pipeline/extract/dom-blocks.js";
import { followupKey, processFollowup } from "../src/pipeline/extract/followup.js";
import { todayIso } from "../src/shared/dates.js";
import { sha256 } from "../src/shared/hash.js";
import type { PipelineError, PipelineState, Source } from "../src/types/index.js";

import { event } from "./helpers.js";

const src: Source = {
  id: "gmina-test", name: "Gmina Testowa", type: "city_portal",
  url: "https://www.gmina.test/wydarzenia", town: "Testowo", fetch: "plain", verified: true,
};

const card = (n: number): string =>
  `<li class="ev"><h3>Wydarzenie numer ${n}</h3><p>Opis wydarzenia ${n}, sala widowiskowa, wstęp wolny.</p></li>`;
const PAGE_HTML = `<html><body><main><ul>${[1, 2, 3, 4].map(card).join("")}</ul></main></body></html>`;

const state = (): PipelineState => ({ hashes: {}, geo: {}, extractions: {}, blocks: {} });

const realFetch = globalThis.fetch;
let llmCalls = 0;

/** Sieć: strony po adresie, OpenRouter policzony i odrzucony (żaden test nie ma prawa tam trafić). */
function stubNetwork(pages: Record<string, string>): void {
  llmCalls = 0;
  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("openrouter.ai")) {
      llmCalls += 1;
      return Promise.reject(new TypeError("test nie pozwala wołać modelu"));
    }
    const body = pages[url];
    if (body === undefined) return Promise.reject(new TypeError(`fetch failed ← brak atrapy dla ${url}`));
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/html" } }));
  };
}

const ctx = (st: PipelineState, pageHash?: string): Parameters<typeof processFollowup>[1] => ({
  src, state: st, errors: [] as PipelineError[], pageHash,
});

beforeEach(() => { suppressArchive(true); });
afterEach(() => { globalThis.fetch = realFetch; suppressArchive(false); });

describe("followupKey — jeden zasób, jeden klucz", () => {
  it("`www.` i końcowy ukośnik nie robią drugiego wpisu w cache'u", () => {
    assert.equal(followupKey("https://www.swarzedz.pl/index.php?id=618"),
      followupKey("https://swarzedz.pl/index.php?id=618"));
    assert.equal(followupKey("https://kornik.pl/kalendarium/"),
      followupKey("http://www.kornik.pl/kalendarium"));
  });

  it("różne ścieżki zostają różne — normalizacja nie ma sklejać zasobów", () => {
    assert.notEqual(followupKey("https://lubon.pl/kalendarium/1/5"),
      followupKey("https://lubon.pl/kalendarium/2/5"));
  });
});

describe("warstwa 3: followup oddał treść strony źródła", () => {
  const URL = "https://www.gmina.test/wydarzenia?page=1";

  it("jest pomijany, nie wnosi wydarzeń i nie woła modelu", async () => {
    stubNetwork({ [URL]: PAGE_HTML });
    const st = state();
    const fr = await processFollowup(URL, ctx(st, sha256(toText(PAGE_HTML))));

    assert.equal(fr.outcome, "same-as-page");
    assert.equal(fr.events, 0);
    assert.equal(llmCalls, 0);
  });

  it("kasuje wpis w cache'u — to on wnosił drugą kopię wydarzeń strony", async () => {
    stubNetwork({ [URL]: PAGE_HTML });
    const st = state();
    st.extractions = {
      [followupKey(URL)]: { hash: "stary", events: [event()], at: "2026-08-01T00:00:00.000Z" },
    };

    await processFollowup(URL, ctx(st, sha256(toText(PAGE_HTML))));
    assert.equal(st.extractions[followupKey(URL)], undefined);
  });

  it("bez hasza strony (304 bez cache'u) warstwa milczy zamiast zgadywać", async () => {
    stubNetwork({ [URL]: PAGE_HTML });
    const st = state();
    // brak pageHash → nie ma z czym porównać, więc treść MUSI iść do modelu (w teście
    // niedostępnego). Ważne jest, że nie została po cichu pominięta jako „ta sama, co strona".
    const fr = await processFollowup(URL, ctx(st, undefined));
    assert.notEqual(fr.outcome, "same-as-page");
    assert.equal(fr.outcome, "error");
  });
});

describe("ścieżka blokowa dla followupów", () => {
  const URL = "https://www.gmina.test/wydarzenia/koncert";

  /** Bloki tej strony wpisane do wspólnego cache'a — tak, jakby przeczytało je inne źródło. */
  function seedBlocks(st: PipelineState, html: string): number {
    const today = todayIso();
    const { blocks } = segmentHtml(html);
    for (const [i, b] of blocks.entries()) {
      st.blocks![b.hash] = {
        events: i === 0 ? [event({ title: "Z bloku", date_start: "2027-01-01" })] : [],
        followups: [], at: today, seen: today,
      };
    }
    return blocks.length;
  }

  it("podstrona złożona ze znanych bloków nie kosztuje ani jednego wywołania", async () => {
    stubNetwork({ [URL]: PAGE_HTML });
    const st = state();
    const total = seedBlocks(st, PAGE_HTML);

    const fr = await processFollowup(URL, ctx(st, "hash-innej-strony"));

    assert.equal(llmCalls, 0);
    assert.equal(fr.outcome, "ok");
    assert.deepEqual(fr.blocks, { total, cached: total, fresh: 0 });
    // wydarzenie z zasianego bloku wróciło jako wynik podstrony
    assert.equal(fr.events, 1);
  });

  it("rozliczenie podziału siedzi przy followupie, nie przy źródle", async () => {
    stubNetwork({ [URL]: PAGE_HTML });
    const st = state();
    seedBlocks(st, PAGE_HTML);
    const fr = await processFollowup(URL, ctx(st, "hash-innej-strony"));
    // SourceRun.blocks opisuje SAMĄ stronę źródła — followup nie ma prawa go dotknąć,
    // bo źródło ma jedną stronę i do pięciu followupów
    assert.ok(fr.blocks, "followup niesie własne rozliczenie bloków");
  });
});

describe("warstwa 2: ten sam hash treści pod znormalizowanym kluczem", () => {
  it("drugie pobranie tego samego zasobu, pisane inaczej, idzie z cache'a", async () => {
    const withWww = "https://www.gmina.test/wydarzenia/koncert";
    const withoutWww = "https://gmina.test/wydarzenia/koncert";
    stubNetwork({ [withWww]: PAGE_HTML, [withoutWww]: PAGE_HTML });

    const st = state();
    st.extractions = {
      [followupKey(withWww)]: {
        hash: sha256(toText(PAGE_HTML)),
        events: [event({ title: "Z wczoraj" })],
        at: "2026-08-11T00:00:00.000Z",
      },
    };

    const fr = await processFollowup(withoutWww, ctx(st, "hash-innej-strony"));

    assert.equal(llmCalls, 0);
    assert.equal(fr.outcome, "unchanged");
    assert.equal(fr.events, 1);
    // nadal JEDEN wpis — surowy adres dopisałby drugi i płacilibyśmy za te same bajty
    assert.equal(Object.keys(st.extractions).length, 1);
  });
});
