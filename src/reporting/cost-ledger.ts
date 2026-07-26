/**
 * Księga kosztów: jedna linia na (przebieg × kategoria) w `costs.json`.
 *
 * Po co osobny plik, skoro koszt jest już w raportach przebiegów:
 *   - runs.json trzyma 7 dni pełnych szczegółów (46 źródeł × followupy), a trend wydatków
 *     ma sens dopiero w skali miesiąca — księga jest o dwa rzędy wielkości mniejsza,
 *     więc może żyć 90 dni bez pompowania repo,
 *   - discover (etap 1) i daily (etap 2) piszą do dwóch różnych plików, a rachunek
 *     przychodzi jeden — wykres „ile dziennie" musi je widzieć razem,
 *   - LLM zwraca kwotę, Bright Data i storage rozliczają się per-jednostkę. Jedno miejsce,
 *     w którym wolumen spotyka się ze stawką, jest jednocześnie jedynym miejscem, gdzie
 *     widać różnicę między „kwotą od dostawcy" a „naszym szacunkiem" (pole `estimated`).
 *
 * Stawki (wszystkie opcjonalne, patrz .env.example):
 *   BD_COST_PER_RECORD          domyślnie 0.0015  ($1.5/1000 rekordów)
 *   BRAVE_COST_PER_QUERY        domyślnie 0       (darmowy tier 2000/mies.)
 *   SUPABASE_COST_PER_GB_MONTH  domyślnie 0       (darmowy tier ~1 GB)
 *   SCRAPE_COST_PER_FETCH       domyślnie 0       (GH Actions dla repo publicznego)
 *   COST_MONTHLY_BUDGET_USD     domyślnie 15      (linia odniesienia w panelu)
 *   COST_RETENTION_DAYS         domyślnie 90
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { describeError } from "../shared/errors.js";
import { dayOffset } from "../shared/dates.js";
import { COSTS_PATH } from "../shared/paths.js";
import type { CostCategory, CostDriver, CostEntry, CostLedger, CostRates, CostUnit } from "../types/index.js";

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const v = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

export const costRates = (): CostRates => ({
  bdPerRecord: num("BD_COST_PER_RECORD", 0.0015),
  bravePerQuery: num("BRAVE_COST_PER_QUERY", 0),
  storagePerGbMonth: num("SUPABASE_COST_PER_GB_MONTH", 0),
  scrapePerFetch: num("SCRAPE_COST_PER_FETCH", 0),
  monthlyBudgetUsd: num("COST_MONTHLY_BUDGET_USD", 15),
});

const RETENTION_DAYS = (): number => num("COST_RETENTION_DAYS", 90);

/** Ile najdroższych pozycji zostaje przy wpisie. Reszta i tak jest w raporcie przebiegu. */
const TOP_DRIVERS = 5;

export interface CostInput {
  category: CostCategory;
  usd: number;
  /** false = kwota od dostawcy, true = wolumen × stawka */
  estimated: boolean;
  units: number;
  unit: CostUnit;
  tokensIn?: number;
  tokensOut?: number;
  /** pełna lista pozycji; do wpisu trafia TOP_DRIVERS najdroższych */
  drivers?: CostDriver[];
  /** kategoria odtworzona ze starego raportu (backfill), nie zmierzona przy wywołaniu */
  inferred?: boolean;
}

const round = (v: number, places = 6): number => Number(v.toFixed(places));

/** Wpis księgi z surowego wolumenu. Kategoria bez wolumenu i bez kwoty nie zaśmieca pliku. */
export function costEntries(
  stage: CostEntry["stage"],
  run: string,
  inputs: CostInput[],
  /** znacznik zapisu; backfill podaje czas przebiegu, żeby księga została chronologiczna */
  at = new Date().toISOString(),
): CostEntry[] {
  const day = run.slice(0, 10);
  const out: CostEntry[] = [];
  for (const i of inputs) {
    if (!i.units && !i.usd) continue;
    const top = (i.drivers ?? [])
      .filter((d) => d.usd > 0 || d.units > 0)
      .sort((a, b) => b.usd - a.usd || b.units - a.units)
      .slice(0, TOP_DRIVERS)
      .map((d) => ({ ...d, usd: round(d.usd) }));
    out.push({
      day, at, stage, run,
      category: i.category,
      usd: round(i.usd),
      estimated: i.estimated,
      units: round(i.units, 3),
      unit: i.unit,
      ...(i.tokensIn ? { tokensIn: i.tokensIn } : {}),
      ...(i.tokensOut ? { tokensOut: i.tokensOut } : {}),
      ...(top.length ? { top } : {}),
      ...(i.inferred ? { inferred: true } : {}),
    });
  }
  return out;
}

export async function loadCostEntries(): Promise<CostEntry[]> {
  if (!existsSync(COSTS_PATH)) return [];
  try {
    const parsed: unknown = JSON.parse(await readFile(COSTS_PATH, "utf-8"));
    const entries = (parsed as Partial<CostLedger>)?.entries;
    return Array.isArray(entries) ? entries : [];
  } catch (e) {
    // uszkodzona księga nie może wywrócić przebiegu — historia zaczyna się od nowa,
    // a poprzednia wersja i tak zostaje w historii gita
    console.warn(`costs.json nie do odczytania (${describeError(e)}) — księga zaczyna się od nowa`);
    return [];
  }
}

/**
 * Dopisuje wpisy do księgi i przycina ją do `COST_RETENTION_DAYS`.
 * Ponowne uruchomienie tego samego dnia dokłada wpisy (bo faktycznie kosztuje drugi raz),
 * ale wpisy z tego samego `run` są zastępowane — powtórzony zapis raportu nie ma
 * podwajać kwoty.
 */
export async function recordCosts(entries: CostEntry[]): Promise<void> {
  if (!entries.length) return;
  const runs = new Set(entries.map((e) => `${e.run}|${e.stage}`));
  const cutoff = dayOffset(RETENTION_DAYS());
  const kept = (await loadCostEntries()).filter(
    (e) => e.day >= cutoff && !runs.has(`${e.run}|${e.stage}`),
  );
  const ledger: CostLedger = {
    updated: new Date().toISOString(),
    rates: costRates(),
    retentionDays: RETENTION_DAYS(),
    entries: [...kept, ...entries].sort((a, b) => a.at.localeCompare(b.at)),
  };
  await writeFile(COSTS_PATH, JSON.stringify(ledger, null, 1), "utf-8");
}

const LABEL: Record<CostCategory, string> = {
  "llm-extract": "tekst",
  "llm-vision": "plakaty",
  "llm-discover": "discovery",
  "llm-verify": "verify",
  fb: "FB",
  search: "search",
  scrape: "scrape",
  geo: "geo",
  storage: "storage",
};

export const totalUsd = (entries: CostEntry[]): number =>
  entries.reduce((sum, e) => sum + e.usd, 0);

/** „$0.1240 (tekst $0.09 · plakaty $0.03 · FB $0.01~)" — `~` oznacza szacunek ze stawki. */
export function costLine(entries: CostEntry[]): string {
  const parts = entries
    .filter((e) => e.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .map((e) => `${LABEL[e.category]} $${e.usd.toFixed(4)}${e.estimated ? "~" : ""}`);
  const total = totalUsd(entries);
  return `$${total.toFixed(4)}` + (parts.length > 1 ? ` (${parts.join(" · ")})` : "");
}
