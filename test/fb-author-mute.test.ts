/**
 * Wyciszanie autora plakatów. Mechanizm KASUJE cudze wydarzenia, więc testy pilnują przede
 * wszystkim dróg powrotnych — wygasania i zerowania licznika. Wyciszenie, które raz zapadło
 * i nie wraca, jest tu błędem projektowym, a nie oszczędnością: rolnik od borówek zimą
 * potrafi ogłosić kolędowanie i nikt się nie dowie, że go nie czytamy.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { authorKey, authorMuted, noteAuthorRead, pruneAuthors } from "../src/pipeline/extract/fb-author-mute.js";
import { addDays, todayIso } from "../src/shared/dates.js";
import type { PipelineState } from "../src/types/index.js";

const st = (): PipelineState => ({ hashes: {}, geo: {} });
const withSalt = (fn: () => void): void => {
  process.env["FB_AUTHOR_SALT"] = "sól-testowa";
  try { fn(); } finally { delete process.env["FB_AUTHOR_SALT"]; }
};

describe("authorKey — tożsamość bez tożsamości", () => {
  it("bez soli mechanizm nie rusza — klucza nie ma", () => {
    assert.equal(authorKey("https://fb.test/rolnik"), null);
  });

  it("z solą daje stabilny hasz, w którym nie ma id autora", () => {
    withSalt(() => {
      const k = authorKey("https://fb.test/rolnik");
      assert.equal(typeof k, "string");
      assert.equal(k, authorKey("https://fb.test/rolnik"), "ten sam autor → ten sam klucz");
      assert.notEqual(k, authorKey("https://fb.test/dom-kultury"));
      assert.equal(k?.includes("rolnik"), false);
    });
  });

  it("brak autora w rekordzie to nie powód do wyciszania kogokolwiek", () => {
    withSalt(() => assert.equal(authorKey(null), null));
  });
});

describe("noteAuthorRead / authorMuted", () => {
  it("trzy puste plakaty wyciszają, dwa jeszcze nie", () => {
    withSalt(() => {
      const s = st();
      const k = authorKey("https://fb.test/rolnik");
      noteAuthorRead(k, 0, s);
      noteAuthorRead(k, 0, s);
      assert.equal(authorMuted(k, s), false, "dwa to za mało — próg to trzy");
      noteAuthorRead(k, 0, s);
      assert.equal(authorMuted(k, s), true);
    });
  });

  it("jedno wydarzenie kasuje historię — kto coś zorganizował, nie jest szumem", () => {
    withSalt(() => {
      const s = st();
      const k = authorKey("https://fb.test/dom-kultury");
      noteAuthorRead(k, 0, s);
      noteAuthorRead(k, 0, s);
      noteAuthorRead(k, 2, s);
      noteAuthorRead(k, 0, s);
      assert.equal(authorMuted(k, s), false, "licznik wystartował od zera po sukcesie");
    });
  });

  it("wyciszenie wygasa, a po wygaśnięciu autor ma PEŁNĄ pulę prób", () => {
    withSalt(() => {
      const s = st();
      const k = authorKey("https://fb.test/rolnik");
      for (let i = 0; i < 3; i++) noteAuthorRead(k, 0, s);
      assert.equal(authorMuted(k, s), true);

      // cofamy termin, tak jakby minęło 30 dni
      s.fbPosterAuthors![k!]!.mutedUntil = addDays(todayIso(), -1);
      assert.equal(authorMuted(k, s), false, "termin minął → wraca do odczytu");
      noteAuthorRead(k, 0, s);
      assert.equal(authorMuted(k, s), false, "jeden pusty plakat nie wycisza od razu z powrotem");
    });
  });

  it("bez soli nic się nie zapisuje — mechanizm jest wyłączony, nie cichy", () => {
    const s = st();
    noteAuthorRead(authorKey("https://fb.test/ktos"), 0, s);
    assert.equal(s.fbPosterAuthors, undefined);
  });
});

describe("pruneAuthors", () => {
  it("wyrzuca tych, po których ślad zaginął, zostawia świeżych", () => {
    const s = st();
    s.fbPosterAuthors = {
      stary: { empty: 3, at: "2026-01-01" },
      swiezy: { empty: 1, at: addDays(todayIso(), -10) },
    };
    pruneAuthors(s, todayIso());
    assert.deepEqual(Object.keys(s.fbPosterAuthors), ["swiezy"]);
  });
});
