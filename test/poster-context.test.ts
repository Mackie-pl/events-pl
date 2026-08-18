/**
 * Odczyt plakatu ma dwa nowe kształty, których nie sprawdzi żaden przebieg: schemat
 * odpowiedzi (bez `followups`) i kontekst doklejany do obrazu. Samego wywołania modelu
 * nie da się tu zweryfikować bez płacenia, więc testy trzymają się tego, co JEST darmową
 * wyrocznią: kształtu wysyłanego kontraktu i przypisania kontekstu do odnośnika.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { unionOf } from "../src/pipeline/extract/block-source.js";
import { POSTER_SYSTEM } from "../src/pipeline/prompts.js";
import { ExtractionSchema, PosterExtractionSchema } from "../src/types/event-schema.js";
import type { PipelineState } from "../src/types/index.js";
import { event } from "./helpers.js";

describe("kontrakt odpowiedzi dla plakatu", () => {
  it("nie ma pola followups — nikt go nie czytał, a wymagane pole zaprasza do zmyślenia URL-a", () => {
    assert.ok("followups" in ExtractionSchema.properties, "ścieżka tekstowa followupów używa");
    assert.equal("followups" in PosterExtractionSchema.properties, false);
    assert.ok("events" in PosterExtractionSchema.properties);
  });

  it("kształt wydarzenia jest TEN SAM co w ekstrakcji tekstowej, nie drugą kopią", () => {
    assert.deepEqual(
      Object.keys(PosterExtractionSchema.properties.events.items.properties),
      Object.keys(ExtractionSchema.properties.events.items.properties),
    );
  });

  it("prompt nie obiecuje już followupów, a mówi, po co jest kontekst", () => {
    assert.equal(POSTER_SYSTEM.includes('"followups"'), false);
    assert.ok(POSTER_SYSTEM.includes("KONTEKST"));
    // asymetria jest tu całą regułą: kontekst uzupełnia plakat, nie zastępuje go
    assert.ok(POSTER_SYSTEM.includes("NIE bierz daty z kontekstu"));
  });
});

describe("unionOf — który blok jest kontekstem followupa", () => {
  const state = (blocks: Record<string, string[]>): PipelineState => ({
    hashes: {}, geo: {},
    blocks: Object.fromEntries(Object.entries(blocks).map(([hash, followups]) => [
      hash, { events: [event()], followups, at: "2026-08-18", seen: "2026-08-18" },
    ])),
  });

  it("plakat dostaje tekst bloku, w którym model go wskazał", () => {
    const u = unionOf(
      [{ text: "Koncert w sobotę", hash: "h1", chars: 16 },
        { text: "Kontakt do biura", hash: "h2", chars: 16 }],
      state({ h1: ["https://x.test/plakat.jpg"], h2: [] }),
      "2026-08-18",
    );
    assert.equal(u.context.get("https://x.test/plakat.jpg"), "Koncert w sobotę");
  });

  it("ten sam plakat w dwóch blokach bierze pierwszy — drugi to zwykle „zobacz też”", () => {
    const u = unionOf(
      [{ text: "Opis wydarzenia", hash: "h1", chars: 15 },
        { text: "Zobacz też", hash: "h2", chars: 10 }],
      state({ h1: ["https://x.test/p.jpg"], h2: ["https://x.test/p.jpg"] }),
      "2026-08-18",
    );
    assert.equal(u.context.get("https://x.test/p.jpg"), "Opis wydarzenia");
    assert.deepEqual(u.followups, ["https://x.test/p.jpg"], "odnośnik nadal jeden");
  });

  it("blok bez wpisu w cache nie wnosi ani odnośnika, ani kontekstu", () => {
    const u = unionOf(
      [{ text: "Nowy blok", hash: "nieznany", chars: 9 }], state({}), "2026-08-18",
    );
    assert.equal(u.context.size, 0);
    assert.deepEqual(u.followups, []);
  });
});
