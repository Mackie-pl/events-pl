/**
 * Licznik niedostępnych grup FB decyduje o tym, czy codziennie płacimy za wiersz błędu —
 * i, w drugą stronę, czy żywa grupa nie zostanie wyłączona za awarię po stronie dostawcy.
 * Oba błędy są ciche: pierwszy widać dopiero na rachunku, drugi dopiero po tygodniach
 * braku wydarzeń z gminy.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { blockedSkip, noteFbGroup } from "../src/pipeline/extract/fb-group-blocked.js";
import type { FbGroupStats, PipelineState, Source } from "../src/types/index.js";

const state = (): PipelineState => ({ hashes: {}, geo: {} });

const group: Source = {
  id: "g", name: "Grupa", type: "fb_group", url: "https://www.facebook.com/groups/1",
  town: "Luboń", fetch: "fb_group", verified: true,
};

const blocked: FbGroupStats =
  { records: 1, posts: 0, errorRows: 1, sharedOnly: 0, imageOnly: 0, limit: 50, atLimit: false,
    blockedWhy: "Group is private" };
const healthy: FbGroupStats =
  { records: 50, posts: 50, errorRows: 0, sharedOnly: 0, imageOnly: 0, limit: 50, atLimit: true,
    postsPerDay: 8 };
/** Bright Data nie oddało nic: timeout, 401, anulowana migawka. */
const nothing: FbGroupStats =
  { records: 0, posts: 0, errorRows: 0, sharedOnly: 0, imageOnly: 0, limit: 50, atLimit: false };

describe("fb-group-blocked", () => {
  it("pojedynczy wiersz błędu jeszcze nie wyłącza grupy", () => {
    const s = state();
    noteFbGroup("g", blocked, s, "2026-08-11");
    assert.equal(s.fbGroupBlocked?.["g"]?.runs, 1);
    assert.equal(blockedSkip(group, s, "2026-08-11"), null, "jeden błąd bywa chwilowy");
  });

  it("dopiero seria (domyślnie 3) przestaje kosztować", () => {
    const s = state();
    for (const day of ["2026-08-11", "2026-08-12", "2026-08-13"]) noteFbGroup("g", blocked, s, day);
    const entry = blockedSkip(group, s, "2026-08-14");
    assert.ok(entry, "po trzeciej próbie z rzędu pomijamy");
    assert.equal(entry.runs, 3);
    assert.equal(entry.since, "2026-08-11", "data „od kiedy” liczy się od PIERWSZEJ próby");
    assert.equal(entry.why, "Group is private");
  });

  it("jeden post kasuje licznik — liczy się seria, nie historia", () => {
    const s = state();
    noteFbGroup("g", blocked, s, "2026-08-11");
    noteFbGroup("g", blocked, s, "2026-08-12");
    noteFbGroup("g", healthy, s, "2026-08-13");
    assert.equal(s.fbGroupBlocked?.["g"], undefined);
    assert.equal(blockedSkip(group, s, "2026-08-14"), null);
  });

  it("cisza od Bright Data nie jest dowodem na grupę", () => {
    const s = state();
    noteFbGroup("g", nothing, s, "2026-08-11");
    assert.equal(s.fbGroupBlocked?.["g"], undefined,
      "zero rekordów to awaria dostawcy — karanie za nią wyłączałoby zdrowe grupy");
  });

  it("sonda wraca po RECHECK_DAYS i jest jedyną drogą powrotu", () => {
    const s = state();
    for (const day of ["2026-08-11", "2026-08-12", "2026-08-13"]) noteFbGroup("g", blocked, s, day);
    assert.ok(blockedSkip(group, s, "2026-08-26"), "13 dni po ostatniej próbie — jeszcze pomijamy");
    assert.equal(blockedSkip(group, s, "2026-08-27"), null, "14. dzień — jedna sonda");
  });

  it("nieudana sonda przesuwa termin następnej, nie odblokowuje na stałe", () => {
    const s = state();
    for (const day of ["2026-08-11", "2026-08-12", "2026-08-13"]) noteFbGroup("g", blocked, s, day);
    noteFbGroup("g", blocked, s, "2026-08-27"); // sonda, dalej sam błąd
    assert.ok(blockedSkip(group, s, "2026-08-28"));
    assert.equal(s.fbGroupBlocked?.["g"]?.runs, 4);
  });

  it("dotyczy wyłącznie grup — zwykłe źródło nigdy nie wpada w ten mechanizm", () => {
    const s = state();
    for (const day of ["2026-08-11", "2026-08-12", "2026-08-13"]) noteFbGroup("g", blocked, s, day);
    assert.equal(blockedSkip({ ...group, fetch: "plain" }, s, "2026-08-14"), null);
  });
});
