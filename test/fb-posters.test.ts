/**
 * Ścieżka plakatów z grup FB. Samego odczytu (pobranie + model) nie da się tu sprawdzić bez
 * płacenia, więc testy pilnują tego, co jest darmową wyrocznią i co przy pomyłce kosztuje
 * pieniądze albo wydarzenia: wyboru postów do przeczytania, klucza cache'u i przycinania.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fbPosterJobs } from "../src/pipeline/facebook.js";
import { posterKey, startFbPosterRun } from "../src/pipeline/extract/fb-posters.js";
import type { PipelineState } from "../src/types/index.js";
import { event } from "./helpers.js";

describe("fbPosterJobs — co idzie do odczytu", () => {
  const img = "https://scontent.xx.fbcdn.net/v/t39.30808-6/775132359_147538.jpg?oe=6A8864BD";

  it("post z obrazem daje zadanie z treścią postu jako kontekstem", () => {
    const jobs = fbPosterJobs([
      { content: "Zapraszamy w sobotę!", url: "https://fb.test/p/1", attachments: [{ url: img }] },
    ]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.context, "Zapraszamy w sobotę!");
    assert.equal(jobs[0]?.postUrl, "https://fb.test/p/1");
  });

  it("post bez obrazu, wiersz błędu i post bez adresu nie tworzą zadań", () => {
    assert.deepEqual(fbPosterJobs([
      { content: "Sam tekst", url: "https://fb.test/p/2" },
      { error: "Group is private", attachments: [{ url: img }] },
      { content: "Bez adresu", attachments: [{ url: img }] },
    ]), []);
  });

  it("galeria to jedno zadanie — płacimy za pierwszy obraz, nie za wszystkie", () => {
    const jobs = fbPosterJobs([
      { content: "Foto", url: "https://fb.test/p/3", photos: [img, img + "&x=2", img + "&x=3"] },
    ]);
    assert.equal(jobs.length, 1);
  });
});

/**
 * Adres z fbcdn jest PODPISANY i wygasa — `oh`/`oe` są inne przy każdym pobraniu grupy.
 * Klucz liczony z całego URL-a nie trafiłby nigdy, więc ten sam plakat byłby kupowany
 * codziennie, dopóki post wisi w oknie grupy. To jest test na rachunek, nie na estetykę.
 */
describe("posterKey — tożsamość plakatu mimo rotującego podpisu", () => {
  it("dwa podpisy tego samego zasobu dają jeden klucz", () => {
    const a = "https://scontent.xx.fbcdn.net/v/t39.30808-6/775132359_147538.jpg?oh=00_AAA&oe=6A8864BD";
    const b = "https://scontent.xx.fbcdn.net/v/t39.30808-6/775132359_147538.jpg?oh=00_ZZZ&oe=6A99FFFF";
    assert.equal(posterKey(a), posterKey(b));
  });

  it("różne zasoby dają różne klucze", () => {
    const a = "https://scontent.xx.fbcdn.net/v/t39.30808-6/111_a.jpg?oe=1";
    const b = "https://scontent.xx.fbcdn.net/v/t39.30808-6/222_b.jpg?oe=1";
    assert.notEqual(posterKey(a), posterKey(b));
  });

  it("śmieć zamiast adresu nie wywraca odczytu", () => {
    assert.equal(posterKey("nie-url"), "fbposter:nie-url");
  });
});

describe("startFbPosterRun — przycinanie cache'u", () => {
  const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
  const state = (): PipelineState => ({
    hashes: {}, geo: {},
    extractions: {
      "fbposter:minione": { hash: "x", at: day(1), events: [event({ date_start: "2026-01-01" })] },
      "fbposter:przyszłe": { hash: "x", at: day(1), events: [event({ date_start: "2026-12-01" })] },
      "fbposter:puste-świeże": { hash: "x", at: day(3), events: [] },
      "fbposter:puste-stare": { hash: "x", at: day(40), events: [] },
      "https://inny.test/a": { hash: "x", at: day(90), events: [] },
    },
  });

  it("wyrzuca minione i puste od dawna, zostawia resztę", () => {
    const st = state();
    startFbPosterRun(st, "2026-08-19");
    assert.deepEqual(Object.keys(st.extractions ?? {}).sort(), [
      "fbposter:przyszłe", "fbposter:puste-świeże", "https://inny.test/a",
    ]);
  });

  it("nie rusza cache'u followupów — inny prefiks, inne reguły", () => {
    const st = state();
    startFbPosterRun(st, "2026-08-19");
    assert.ok(st.extractions?.["https://inny.test/a"], "wpis followupa ma 90 dni i zostaje");
  });
});
