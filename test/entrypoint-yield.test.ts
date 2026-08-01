/**
 * Rozliczenie entrypointów z plonu.
 *
 * Regresja, którą to zamyka: do lipca 2026 zły entrypoint nie miał ŻADNEJ drogi wyjścia
 * z rejestru. `daily` tylko go czytało, `applyProfile` nadpisywało go co miesiąc tym samym
 * błędnym adresem, a wynik ekstrakcji nigdy nie wracał do jego wiarygodności. Adres taki jak
 * `lubon.pl/artykuly/350/wydarzenia` — artykuł o cyklicznych imprezach, który heurystyka
 * wzięła za listę — zostawał tam na zawsze i kosztował pobranie dziennie.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  BARREN_LIMIT, carryBarrenRuns, reconcileEntrypoints,
} from "../src/pipeline/discover/entrypoint-yield.js";
import type { EntryPoint, PipelineState, Source } from "../src/types/index.js";

const ep = (over: Partial<EntryPoint> = {}): EntryPoint => ({
  url: "https://gok.test/wydarzenia", kind: "listing", confidence: 0.6, via: "heuristic", ...over,
});

const source = (over: Partial<Source> = {}): Source => ({
  id: "gok", name: "GOK", type: "culture_center", url: "https://gok.test/",
  town: "Luboń", fetch: "plain", verified: true, entrypoints: [ep()], ...over,
});

/** Stan z jedną ekstrakcją pod danym adresem. */
const state = (url: string, events: number): PipelineState => ({
  hashes: {}, geo: {},
  extractions: {
    [url]: { hash: "h", at: "2026-08-01T00:00:00Z", events: Array.from({ length: events }, () => ({})) },
  },
} as unknown as PipelineState);

/** Ile pudeł trzeba dołożyć, żeby kolejne przekroczyło próg. */
const atLimit = BARREN_LIMIT - 1;

describe("reconcileEntrypoints — nalicza jałowe przebiegi", () => {
  it("zero wydarzeń to pudło, ale nie od razu wyrok", () => {
    const src = source();
    const out = reconcileEntrypoints([src], state("https://gok.test/wydarzenia", 0));

    assert.deepEqual(out.dropped, []);
    assert.equal(src.entrypoints?.[0]?.barrenRuns, 1);
  });

  it("po BARREN_LIMIT przebiegach adres wypada z rejestru", () => {
    const src = source({ entrypoints: [ep({ barrenRuns: atLimit })] });
    const out = reconcileEntrypoints([src], state("https://gok.test/wydarzenia", 0));

    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0]?.url, "https://gok.test/wydarzenia");
    assert.equal(src.entrypoints, undefined, "ostatni entrypoint znika razem z polem");
  });

  it("plon zeruje licznik — adres udowodnił, że działa", () => {
    const src = source({ entrypoints: [ep({ barrenRuns: atLimit })] });
    const out = reconcileEntrypoints([src], state("https://gok.test/wydarzenia", 4));

    assert.deepEqual(out.dropped, []);
    assert.equal(src.entrypoints?.[0]?.barrenRuns, undefined);
  });
});

describe("reconcileEntrypoints — brak pomiaru to nie pudło", () => {
  it("adres, którego daily nigdy nie pobrało, zostaje nietknięty", () => {
    // karanie za brak pomiaru byłoby tym samym błędem co karanie źródła
    // za brak trafienia w wyszukiwarce
    const src = source();
    const out = reconcileEntrypoints([src], { hashes: {}, geo: {} });

    assert.deepEqual(out.dropped, []);
    assert.equal(src.entrypoints?.[0]?.barrenRuns, undefined);
  });

  it("szablon z {page} dopasowuje się do adresu pobranego z podstawioną jedynką", () => {
    const src = source({ entrypoints: [ep({ url: "https://gok.test/akt/page/{page}" })] });
    const out = reconcileEntrypoints([src], state("https://gok.test/akt/page/1", 0));

    assert.deepEqual(out.dropped, []);
    assert.equal(src.entrypoints?.[0]?.barrenRuns, 1, "pomiar ZNALEZIONY — inaczej byłby null");
  });
});

describe("carryBarrenRuns — licznik przeżywa nadpisanie profilu", () => {
  it("przenosi licznik na ten sam adres z nowego profilu", () => {
    const fresh = carryBarrenRuns([ep({ confidence: 0.9, via: "llm" })], [ep({ barrenRuns: 1 })]);
    assert.equal(fresh[0]?.barrenRuns, 1);
    assert.equal(fresh[0]?.via, "llm", "reszta opisu pochodzi ze świeżego profilu");
  });

  it("nie przenosi na inny adres", () => {
    const fresh = carryBarrenRuns([ep({ url: "https://gok.test/inne" })], [ep({ barrenRuns: 1 })]);
    assert.equal(fresh[0]?.barrenRuns, undefined);
  });

  it("bez poprzedniego profilu zwraca świeży bez zmian", () => {
    assert.deepEqual(carryBarrenRuns([ep()], undefined), [ep()]);
  });
});
