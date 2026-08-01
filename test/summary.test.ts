/**
 * Budowniczowie podsumowań to czyste składanie napisów, ale mają najwięcej rozgałęzień
 * w całym repo (kolumny warunkowe, ikony, sekcje pojawiające się tylko czasem) — czyli
 * dokładnie to, co przy dzieleniu funkcji najłatwiej zgubić.
 *
 * Test pisze do pliku tymczasowego przez GITHUB_STEP_SUMMARY, bo to jedyne wyjście
 * tych funkcji. Poza Actions są no-opem, więc bez podstawienia zmiennej nie dałoby się
 * ich w ogóle zaobserwować.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writeDailySummary } from "../src/reporting/daily-summary.js";
import { writeDiscoverSummary } from "../src/reporting/discover-summary.js";
import type { DiscoverRunReport, RunReport } from "../src/types/index.js";

let dir: string;
let file: string;
const prev = process.env["GITHUB_STEP_SUMMARY"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "events-pl-summary-"));
  file = join(dir, "summary.md");
  process.env["GITHUB_STEP_SUMMARY"] = file;
});

afterEach(() => {
  if (prev === undefined) delete process.env["GITHUB_STEP_SUMMARY"];
  else process.env["GITHUB_STEP_SUMMARY"] = prev;
  rmSync(dir, { recursive: true, force: true });
});

const read = (): string => readFileSync(file, "utf-8");

const sourceRun = (over: Partial<RunReport["sources"][number]> = {}): RunReport["sources"][number] => ({
  id: "src-a", name: "Źródło A", town: "Poznań", url: "https://a.test/", fetch: "plain",
  status: "ok", events: 3, followups: [], geo: { hits: 1, misses: 0 },
  llm: { calls: 2, promptTokens: 100, completionTokens: 20, costUsd: 0.01 }, ms: 120,
  ...over,
});

const dailyReport = (over: Partial<RunReport> = {}): RunReport => ({
  stage: "daily",
  startedAt: "2026-07-26T04:00:00.000Z",
  finishedAt: "2026-07-26T04:05:00.000Z",
  durationMs: 300_000,
  totals: {
    calls: 2, promptTokens: 100, completionTokens: 20, costUsd: 0.01,
    sources: 1, ok: 1, unchanged: 0, errors: 0,
    skippedFb: 0, skippedDead: 0, skippedInactive: 0, empty: 0,
    events: 3, followupsTried: 0, geoHits: 1, geoMisses: 0, droppedInvalid: 0,
    redactedPhones: 2, redactedEmails: 1,
  },
  sources: [sourceRun()],
  ...over,
});

const discoverReport = (over: Partial<DiscoverRunReport> = {}): DiscoverRunReport => ({
  stage: "discover",
  mode: "full",
  startedAt: "2026-07-01T03:00:00.000Z",
  finishedAt: "2026-07-01T03:20:00.000Z",
  durationMs: 1_200_000,
  towns: [{
    town: "Luboń",
    searches: [{ query: "dom kultury Luboń", results: [], ms: 300 }],
    proposed: 2, added: 1, addedIds: ["gok-lubon"], confirmed: 0,
    proposals: [
      { id: "gok-lubon", name: "GOK Luboń", url: "https://gok.test/", town: "Luboń",
        decision: "added", confidence: 0.9, why: "kalendarz wydarzeń" },
      { id: "x", name: "Coś", url: "https://x.test/", town: "Luboń",
        decision: "low-confidence", confidence: 0.2, reason: "poniżej progu" },
    ],
    parse: "ok",
    llm: { calls: 1, promptTokens: 500, completionTokens: 200, costUsd: 0.05 },
    ms: 4000,
  }],
  verifications: [
    { id: "gok-lubon", name: "GOK Luboń", town: "Luboń", url: "https://gok.test/",
      outcome: "ok", searches: [], llm: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
      ms: 200, isNew: true, probe: { at: "x", url: "https://gok.test/", ok: true, httpStatus: 200, chars: 5000, ms: 200 } },
    { id: "stary", name: "Stary", town: "Poznań", url: "https://old.test/",
      outcome: "fixed", newUrl: "https://new.test/", searches: [],
      llm: { calls: 1, promptTokens: 200, completionTokens: 50, costUsd: 0.002 }, ms: 900 },
  ],
  totals: {
    calls: 2, promptTokens: 700, completionTokens: 250, costUsd: 0.052,
    towns: 1, searches: 1, searchErrors: 0, searchesSkipped: 0,
    sourcesAdded: 1, sourcesConfirmed: 0, sourcesMissed: 0, sourcesDeactivated: 0,
    entrypointsDropped: 0,
    proposalsRejected: 1, sourcesChecked: 2,
    ok: 1, fixed: 1, dead: 0, unrepaired: 0, skipped: 0,
    costDiscoveryUsd: 0.05, costVerifyUsd: 0.002,
    redactedPhones: 0, redactedEmails: 0,
  },
  archiveEnabled: true,
  ...over,
});

describe("writeDailySummary", () => {
  it("niesie nagłówek, liczby i wiersz źródła", () => {
    writeDailySummary(dailyReport());
    const out = read();
    assert.ok(out.includes("## daily"), "nagłówek etapu");
    assert.ok(out.includes("2026-07-26T04:00:00.000Z"), "znacznik przebiegu");
    assert.ok(out.includes("src-a"), "wiersz źródła");
    assert.ok(out.includes("✅"), "ikona statusu");
    assert.ok(out.includes("🔒"), "licznik redakcji PII");
  });

  it("oznacza przebieg z błędami i pomija puste sekcje", () => {
    writeDailySummary(dailyReport({
      sources: [sourceRun({ status: "error", err: "HTTP 500", events: 0 })],
      totals: { ...dailyReport().totals, ok: 0, errors: 1, events: 0 },
    }));
    const out = read();
    assert.ok(out.includes("⚠️"), "ikona błędu");
    assert.ok(out.includes("HTTP 500") || out.includes("error"), "ślad po błędzie");
  });

  it("bez GITHUB_STEP_SUMMARY nic nie pisze i nie rzuca", () => {
    delete process.env["GITHUB_STEP_SUMMARY"];
    writeDailySummary(dailyReport());
    assert.throws(() => read(), /ENOENT/);
  });
});

describe("writeDiscoverSummary", () => {
  it("zawiera tabelę gmin, propozycji i weryfikacji", () => {
    writeDiscoverSummary(discoverReport());
    const out = read();
    assert.ok(out.includes("## discover (full)"), "nagłówek z trybem");
    assert.ok(out.includes("| gmina |"), "tabela gmin");
    assert.ok(out.includes("### Propozycje modelu"), "tabela propozycji");
    assert.ok(out.includes("### Pierwsze pobranie nowych źródeł"), "tabela nowych źródeł");
    assert.ok(out.includes("### Weryfikacja rejestru"), "tabela weryfikacji");
    assert.ok(out.includes("gok-lubon"), "id źródła");
    assert.ok(out.includes("https://new.test/"), "docelowy URL po naprawie");
  });

  it("pokazuje odrzucone propozycje — to osobna diagnoza niż „brak propozycji”", () => {
    const out = (writeDiscoverSummary(discoverReport()), read());
    assert.ok(out.includes("low-confidence"), "odrzucenie widoczne");
    assert.ok(out.includes("poniżej progu"), "powód odrzucenia");
  });

  it("sygnalizuje przerwany przebieg i awarię Overpassa", () => {
    writeDiscoverSummary(discoverReport({
      err: "coś padło", partial: true,
      geo: { query: "q", towns: ["Poznań"], ms: 10, err: "timeout", fallback: true },
    }));
    const out = read();
    assert.ok(out.includes("przebieg przerwany"), "ostrzeżenie o przerwaniu");
    assert.ok(out.includes("Overpass padł"), "ostrzeżenie o Overpassie");
  });

  it("bez archiwum dokłada notkę, że promptów nie da się odtworzyć", () => {
    writeDiscoverSummary(discoverReport({ archiveEnabled: false }));
    assert.ok(read().includes("prywatne archiwum wyłączone"));
  });

  it("przebieg bez gmin (tryb verify) nie generuje pustych tabel", () => {
    writeDiscoverSummary(discoverReport({ mode: "verify", towns: [] }));
    const out = read();
    assert.ok(out.includes("## discover (verify)"));
    assert.ok(!out.includes("| gmina |"), "tabela gmin pominięta");
    assert.ok(out.includes("### Weryfikacja rejestru"), "weryfikacja nadal jest");
  });
});
