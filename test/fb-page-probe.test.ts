/**
 * Dwie rzeczy, które w tej sondzie muszą być policzone dobrze, bo pomyłka w nich albo
 * kosztuje pieniądze, albo prowadzi do złej decyzji o całym kanale FB:
 *
 *   1. SUFIT REKORDÓW — jedyne miejsce w repo kupujące rekordy w pętli po źródłach.
 *      Kształt awarii z 2026-08-10 ($8 za nic), więc plan musi ciąć LISTĘ przed pierwszym
 *      triggerem, a nie budżet w połowie pobrania.
 *   2. NOWOŚĆ — musi znaczyć DOKŁADNIE to, co `novel` przy grupach („nie dała tego żadna
 *      strona"), inaczej kolumny fanpage'ów i grup nie dają się zestawić, a i tak zostaną
 *      zestawione.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildBaseline, planBudget, scorePage } from "../src/reporting/fb-page-probe.js";
import type { BdUsage, EventItem, FbGroupStats, RunReport, SourceRun } from "../src/types/index.js";

const META = { id: "x-fb", name: "X", town: "Luboń", url: "https://fb.test/x", bucket: "no-site" };

const bd = (records: number): BdUsage =>
  ({ triggers: 1, inputs: 1, polls: 1, records, errors: 0, snapshots: [], byDataset: {} });

const run = (over: { bd?: BdUsage; fbGroup?: FbGroupStats } = {}): SourceRun => ({
  id: "x-fb", name: "X", town: "Luboń", url: "https://fb.test/x", fetch: "fb",
  status: "ok", events: 0, followups: [], geo: { hits: 0, misses: 0 },
  llm: { calls: 1, promptTokens: 10, completionTokens: 5, costUsd: 0.01 }, ms: 1,
  ...(over.bd ? { bd: over.bd } : {}),
  ...(over.fbGroup ? { fbGroup: over.fbGroup } : {}),
});

const ev = (title: string, date: string): EventItem =>
  ({ title, date_start: date } as EventItem);

const report = (sources: RunReport["sources"]): RunReport =>
  ({ stage: "daily", startedAt: "2026-08-16T04:00:00.000Z", sources } as RunReport);

describe("planBudget", () => {
  it("tnie LISTĘ do sufitu, zamiast pozwolić przekroczyć budżet", () => {
    const p = planBudget(["a", "b", "c", "d"], 20, 50);
    assert.deepEqual(p.take, ["a", "b"]); // 2 × 20 = 40 ≤ 50, trzecie by przekroczyło
    assert.deepEqual(p.skipped, ["c", "d"]);
    assert.equal(p.plannedRecords, 40);
  });

  it("sufit mniejszy od jednego pobrania nie kupuje nic", () => {
    const p = planBudget(["a"], 20, 5);
    assert.deepEqual(p.take, []);
    assert.equal(p.plannedRecords, 0);
  });

  it("mieszczącą się listę bierze w całości", () => {
    const p = planBudget(["a", "b"], 10, 300);
    assert.deepEqual(p.take, ["a", "b"]);
    assert.deepEqual(p.skipped, []);
  });
});

describe("buildBaseline", () => {
  it("rozdziela dostawców na strony i grupy FB — to rozróżnienie niesie całą definicję nowości", () => {
    const b = buildBaseline([report([
      { id: "www", fetch: "plain", status: "ok", produced: [{ title: "Koncert", date: "2026-09-01" }] },
      { id: "grupa", fetch: "fb_group", status: "ok", produced: [{ title: "Piknik", date: "2026-09-02" }] },
    ] as unknown as RunReport["sources"])], []);
    assert.equal(b.web.has("koncert|2026-09-01"), true);
    assert.equal(b.groups.has("piknik|2026-09-02"), true);
    assert.equal(b.web.has("piknik|2026-09-02"), false);
  });

  it("dokłada opublikowane wydarzenia — okno runs.json bywa krótsze niż events.json", () => {
    const published = [
      { title: "Ze strony", date_start: "2026-09-03", source_id: "kultura-poznan" },
      { title: "Z grupy", date_start: "2026-09-04", source_id: "fb-group-baba-cool" },
    ] as EventItem[];
    const b = buildBaseline([], published);
    assert.equal(b.web.has("zestrony|2026-09-03"), true);
    assert.equal(b.groups.has("zgrupy|2026-09-04"), true);
  });
});

describe("scorePage", () => {
  const baseline = buildBaseline([], [
    { title: "Ma to strona", date_start: "2026-09-01", source_id: "www" },
    { title: "Ma to grupa", date_start: "2026-09-02", source_id: "fb-group-x" },
  ] as EventItem[]);

  it("nowe = czego nie ma ŻADNA strona; osobno liczy, ile z tego dają już grupy", () => {
    const r = scorePage({
      meta: META,
      run: run({ bd: bd(20) }),
      events: [
        ev("Ma to strona", "2026-09-01"), // nie liczy się — jest na stronie
        ev("Ma to grupa", "2026-09-02"),  // nowe wobec stron, ale grupa już je daje
        ev("Nikt tego nie ma", "2026-09-03"),
      ],
      baseline,
      bdPerRecord: 0.0015,
    });
    assert.equal(r.events, 3);
    assert.equal(r.novel, 2);
    assert.equal(r.alsoInGroups, 1);
  });

  it("koszt to rekordy Bright Data PLUS model, a $/nowe liczy się z sumy", () => {
    const r = scorePage({
      meta: META,
      run: run({ bd: bd(20) }),
      events: [ev("Nowe", "2026-09-03")],
      baseline,
      bdPerRecord: 0.0015,
    });
    assert.equal(r.bdUsd, 0.03);
    assert.equal(r.llmUsd, 0.01);
    assert.equal(r.costUsd, 0.04);
    assert.equal(r.usdPerNovel, 0.04);
  });

  it("bez nowych wydarzeń NIE podaje $/nowe — zero w mianowniku udawałoby taniznę", () => {
    const r = scorePage({
      meta: META,
      run: run({ bd: bd(20) }),
      events: [ev("Ma to strona", "2026-09-01")],
      baseline,
      bdPerRecord: 0.0015,
    });
    assert.equal(r.novel, 0);
    assert.equal(r.usdPerNovel, undefined);
    assert.ok(r.costUsd > 0); // ale zapłacone i tak jest — to musi być widać
  });

  it("powtórzony tytuł w tym samym terminie to jedno wydarzenie, nie dwa", () => {
    const r = scorePage({
      meta: META,
      run: run(),
      events: [ev("Piknik", "2026-09-05"), ev("Piknik", "2026-09-05")],
      baseline,
      bdPerRecord: 0.0015,
    });
    assert.equal(r.events, 1);
    assert.equal(r.novel, 1);
  });

  it("niesie „limit wyczerpany”, bo wtedy plon jest ucięty, a nie zmierzony", () => {
    const r = scorePage({
      meta: META,
      run: run({
        fbGroup: { records: 20, posts: 12, errorRows: 0, sharedOnly: 0, imageOnly: 0,
          limit: 20, atLimit: true },
      }),
      events: [],
      baseline,
      bdPerRecord: 0.0015,
    });
    assert.equal(r.atLimit, true);
    assert.equal(r.posts, 12);
  });
});
