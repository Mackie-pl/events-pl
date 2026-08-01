/**
 * Wybór adresu, którym etap 2 wchodzi po wydarzenia.
 *
 * Regresja, którą to zamyka: `processSource` pobierał `Source.url`, czyli KORZEŃ serwisu,
 * mimo że etap 1 od miesiąca zapisywał przy źródle adres listy wydarzeń. 19 z 46 źródeł
 * oddawało zero wydarzeń, a osiem z nich miało zapisaną listę z dziesiątkami odnośników.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { entryUrl } from "../src/pipeline/extract/entry-url.js";
import type { EntryPoint, Source } from "../src/types/index.js";

const source = (over: Partial<Source> = {}): Source => ({
  id: "gok", name: "GOK", type: "culture_center", url: "https://gok.test/",
  town: "Luboń", fetch: "plain", verified: true, ...over,
});

const ep = (over: Partial<EntryPoint> = {}): EntryPoint => ({
  url: "https://gok.test/wydarzenia", kind: "listing", confidence: 0.9, via: "llm", ...over,
});

describe("entryUrl — wejście przez listę wydarzeń", () => {
  it("bez entrypointu wchodzi korzeniem serwisu", () => {
    assert.deepEqual(entryUrl(source()), { url: "https://gok.test/" });
  });

  it("z entrypointem wchodzi listą, nie stroną główną", () => {
    const out = entryUrl(source({ entrypoints: [ep()] }));
    assert.equal(out.url, "https://gok.test/wydarzenia");
    assert.equal(out.entrypoint?.kind, "listing");
  });

  it("paginacja jest podstawiana tak samo jak w korzeniu", () => {
    const out = entryUrl(source({ entrypoints: [ep({ url: "https://gok.test/akt/page/{page}" })] }));
    assert.equal(out.url, "https://gok.test/akt/page/1");
  });
});

describe("entryUrl — wybór spośród kilku", () => {
  it("lista wygrywa z feedem i z api", () => {
    const src = source({
      entrypoints: [
        ep({ url: "https://gok.test/api", kind: "api", confidence: 1 }),
        ep({ url: "https://gok.test/feed", kind: "feed", confidence: 1 }),
        ep({ url: "https://gok.test/lista", kind: "listing", confidence: 0.6 }),
      ],
    });
    // `api` przegrywa mimo pewności 1.0: od maszynowych wyjść jest `capabilities`
    // i osobna ścieżka bez modelu, a nie karmienie modelu JSON-em
    assert.equal(entryUrl(src).url, "https://gok.test/lista");
  });

  it("przy tym samym rodzaju rozstrzyga pewność", () => {
    const src = source({
      entrypoints: [ep({ url: "https://gok.test/a", confidence: 0.6 }), ep({ url: "https://gok.test/b", confidence: 0.9 })],
    });
    assert.equal(entryUrl(src).url, "https://gok.test/b");
  });
});

describe("entryUrl — Facebook", () => {
  it("źródła FB zawsze wchodzą własnym adresem", () => {
    // ścieżka FB idzie przez Bright Data i nie pobiera stron HTTP-em
    const src = source({
      fetch: "fb_group", url: "https://www.facebook.com/groups/lubon",
      entrypoints: [ep()],
    });
    const out = entryUrl(src);
    assert.equal(out.url, "https://www.facebook.com/groups/lubon");
    assert.equal(out.entrypoint, undefined);
  });
});
