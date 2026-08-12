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
 * Stawki (wszystkie opcjonalne, wartości domyślne i opis: src/config/params.ts):
 *   BD_COST_PER_RECORD, SEARCH_COST_PER_QUERY, SUPABASE_COST_PER_GB_MONTH,
 *   SCRAPE_COST_PER_FETCH, COST_MONTHLY_BUDGET_USD, COST_RETENTION_DAYS
 */
import { P } from "../config/index.js";
import { dayOffset } from "../shared/dates.js";
import { collection } from "../storage/index.js";
import type { CollectionStore, Retention } from "../storage/index.js";
import type { CostCategory, CostDriver, CostEntry, CostLedger, CostRates, CostUnit } from "../types/index.js";

export const costRates = (): CostRates => ({
  bdPerRecord: P.BD_COST_PER_RECORD.get(),
  searchPerQuery: P.SEARCH_COST_PER_QUERY.get(),
  storagePerGbMonth: P.SUPABASE_COST_PER_GB_MONTH.get(),
  scrapePerFetch: P.SCRAPE_COST_PER_FETCH.get(),
  monthlyBudgetUsd: P.COST_MONTHLY_BUDGET_USD.get(),
});

const RETENTION_DAYS = (): number => P.COST_RETENTION_DAYS.get();

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

/**
 * Retencja księgi. Przycinamy po dacie DZIENNEJ (nie po znaczniku zapisu), bo oś wykresu
 * w panelu jest dzienna — wpis z 3:59 i z 4:01 tego samego dnia mają wypaść razem.
 * Klucz `run|stage`: ponowny zapis tego samego przebiegu zastępuje wpis, a nie dubluje kwotę.
 */
export const costRetention: Retention<CostEntry> = {
  at: (e) => e.at,
  ageKey: (e) => e.day,
  cutoff: () => dayOffset(RETENTION_DAYS()),
  key: (e) => `${e.run}|${e.stage}`,
};

/**
 * Koperta: obok wpisów zapisujemy stawki obowiązujące w chwili zapisu. Po zmianie
 * cennika stary wpis musi dać się wytłumaczyć stawką, która wtedy obowiązywała.
 */
const ledgerStore: CollectionStore<CostEntry> = collection<CostEntry>("costs", costRetention, {
  unwrap: (raw) => {
    const entries = (raw as Partial<CostLedger> | null)?.entries;
    return Array.isArray(entries) ? entries : [];
  },
  wrap: (entries): CostLedger => ({
    updated: new Date().toISOString(),
    rates: costRates(),
    retentionDays: RETENTION_DAYS(),
    entries,
  }),
});

export const loadCostEntries = (): Promise<CostEntry[]> => ledgerStore.all();

/**
 * Dopisuje wpisy do księgi i przycina ją do `COST_RETENTION_DAYS`.
 * Ponowne uruchomienie tego samego dnia dokłada wpisy (bo faktycznie kosztuje drugi raz),
 * ale wpisy z tego samego `run` są zastępowane — powtórzony zapis raportu nie ma
 * podwajać kwoty.
 */
export const recordCosts = (entries: CostEntry[]): Promise<void> => ledgerStore.append(entries);

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
