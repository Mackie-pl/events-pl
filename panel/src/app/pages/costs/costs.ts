import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import {
  ALL_CATEGORIES,
  CATEGORY_META,
  CHART_CATEGORIES,
  FREE_CATEGORIES,
  fmtDateTime,
  fmtNum,
  fmtTokens,
  fmtUnits,
  fmtUsd,
  fmtUsdTick,
} from '../../format';
import type { CostCategory, CostEntry } from '../../types';

/** Seria wykresu: kategoria płatna albo zbiorcza „infra" (pozycje o stawce zero). */
export type Series = CostCategory | 'infra';

const SERIES: readonly Series[] = [...CHART_CATEGORIES, 'infra'];

const SERIES_LABEL = (s: Series): string =>
  s === 'infra' ? 'Infra (darmowy tier)' : CATEGORY_META[s].label;

/** Slot palety — kolor idzie za serią, nigdy za jej rankingiem w danym oknie. */
const SERIES_SLOT = (s: Series): number => (s === 'infra' ? 6 : CATEGORY_META[s].slot);

const seriesOf = (c: CostCategory): Series =>
  (FREE_CATEGORIES as readonly CostCategory[]).includes(c) ? 'infra' : c;

// ---------------- geometria wykresu ----------------

const VIEW_W = 960;
const VIEW_H = 300;
const PAD = { top: 16, right: 14, bottom: 30, left: 58 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;
/** Słupek nigdy nie wypełnia całego pasma — reszta pasma to powietrze. */
const MAX_BAR_W = 24;
/** Przerwa w kolorze tła między segmentami stosu (2px wg specyfikacji znaków). */
const SEG_GAP = 2;
const CORNER = 4;

export interface Segment {
  day: string;
  series: Series;
  label: string;
  path: string;
  color: string;
  usd: number;
  /** wolumen w postaci gotowej do wyświetlenia, np. „27 calls · 312 fetches" */
  volume: string;
  estimated: boolean;
  inferred: boolean;
  /** procenty viewBoxa — SVG skaluje się proporcjonalnie, więc tooltip trafia w miejsce */
  tipX: number;
  tipY: number;
}

export interface DayColumn {
  day: string;
  total: number;
  /** koszt per seria, w stałej kolejności SERIES */
  bySeries: Record<Series, number>;
  entries: CostEntry[];
  /** przebiegi tego dnia — daily i discover trafiają w różne widoki */
  runs: { run: string; stage: CostEntry['stage'] }[];
}

/**
 * Krok osi z rodziny 1/2/2.5/5 × 10ⁿ. Podział „max/4" dawał podziałki w rodzaju $0.375
 * i $1.13 — oś ma nieść okrągłe liczby, bo to z niej czyta się wartości, których nie
 * podpisaliśmy bezpośrednio.
 */
function niceStep(v: number): number {
  if (v <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5]) {
    if (m * base >= v) return m * base;
  }
  return 10 * base;
}

/** Prostokąt z zaokrąglonym końcem danych; przy baseline i w środku stosu — kwadratowy. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(CORNER, w / 2, h) : 0;
  if (!r) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return (
    `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}` +
    `L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`
  );
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

@Component({
  selector: 'app-costs',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './costs.html',
  styleUrl: './costs.less',
})
export class CostsPage {
  protected readonly data = inject(DataService);

  protected readonly usd = fmtUsd;
  protected readonly usdTick = fmtUsdTick;
  protected readonly num = fmtNum;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly units = fmtUnits;
  protected readonly meta = CATEGORY_META;
  protected readonly allCategories = ALL_CATEGORIES;
  protected readonly series = SERIES;
  protected readonly seriesLabel = SERIES_LABEL;
  protected readonly seriesColor = (s: Series): string => `var(--series-${SERIES_SLOT(s)})`;

  protected readonly ranges = [7, 30, 90] as const;
  protected readonly range = signal<number>(30);
  protected readonly hidden = signal<ReadonlySet<Series>>(new Set());
  protected readonly hover = signal<Segment | null>(null);

  protected readonly ledger = computed(() => this.data.costs.value());
  protected readonly rates = computed(() => this.ledger().rates);
  protected readonly budgetPerDay = computed(() => this.rates().monthlyBudgetUsd / 30);

  protected toggle(s: Series): void {
    const next = new Set(this.hidden());
    if (next.has(s)) next.delete(s);
    else next.add(s);
    // ukrycie wszystkiego zostawiłoby pusty wykres bez drogi powrotnej z klawiatury
    if (next.size < SERIES.length) this.hidden.set(next);
  }

  protected isHidden(s: Series): boolean {
    return this.hidden().has(s);
  }

  /** Dni okna — także te bez przebiegu, żeby dziura w cronie była widoczna jako dziura. */
  protected readonly days = computed<string[]>(() => {
    const n = this.range();
    const end = Date.now();
    return Array.from({ length: n }, (_, i) => isoDay(new Date(end - (n - 1 - i) * DAY_MS)));
  });

  protected readonly windowEntries = computed<CostEntry[]>(() => {
    const from = this.days()[0] ?? '';
    return this.ledger().entries.filter((e) => e.day >= from);
  });

  protected readonly columns = computed<DayColumn[]>(() => {
    const byDay = new Map<string, CostEntry[]>();
    for (const e of this.windowEntries()) {
      byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
    }
    return this.days().map((day) => {
      const entries = byDay.get(day) ?? [];
      const bySeries = Object.fromEntries(SERIES.map((s) => [s, 0])) as Record<Series, number>;
      for (const e of entries) bySeries[seriesOf(e.category)] += e.usd;
      const runs = new Map<string, CostEntry['stage']>();
      for (const e of entries) runs.set(e.run, e.stage);
      return {
        day,
        total: entries.reduce((n, e) => n + e.usd, 0),
        bySeries,
        entries,
        runs: [...runs].map(([run, stage]) => ({ run, stage })),
      };
    });
  });

  /** Suma per seria w oknie — legenda pokazuje kwotę, nie tylko kolor. */
  protected readonly seriesTotals = computed<Record<Series, number>>(() => {
    const out = Object.fromEntries(SERIES.map((s) => [s, 0])) as Record<Series, number>;
    for (const e of this.windowEntries()) out[seriesOf(e.category)] += e.usd;
    return out;
  });

  protected readonly total = computed(() => this.windowEntries().reduce((n, e) => n + e.usd, 0));

  /** Ile z tej kwoty to szacunek ze stawki, a nie kwota od dostawcy. */
  protected readonly estimatedUsd = computed(() =>
    this.windowEntries()
      .filter((e) => e.estimated)
      .reduce((n, e) => n + e.usd, 0),
  );

  protected readonly hasInferred = computed(() => this.windowEntries().some((e) => e.inferred));

  /** Dni, w których cokolwiek się zdarzyło — średnia „na dzień z przebiegiem", nie na dzień kalendarzowy. */
  protected readonly activeDays = computed(
    () => this.columns().filter((c) => c.entries.length).length,
  );

  protected readonly perDay = computed(() => {
    const n = this.activeDays();
    return n ? this.total() / n : 0;
  });

  protected readonly monthToDate = computed(() => {
    const month = isoDay(new Date()).slice(0, 7);
    return this.ledger()
      .entries.filter((e) => e.day.startsWith(month))
      .reduce((n, e) => n + e.usd, 0);
  });

  /** Prognoza końca miesiąca z tempa dotychczasowych dni tego miesiąca. */
  protected readonly projected = computed(() => {
    const now = new Date();
    const elapsed = now.getUTCDate();
    const inMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    return elapsed ? (this.monthToDate() / elapsed) * inMonth : 0;
  });

  protected readonly overBudget = computed(() => this.projected() > this.rates().monthlyBudgetUsd);

  /**
   * Najdroższe pozycje okna: (kategoria × źródło/gmina) zsumowane po dniach.
   * To jest odpowiedź na „dlaczego drożej" — suma dzienna mówi tylko, że drożej jest.
   */
  protected readonly drivers = computed(() => {
    const acc = new Map<
      string,
      { id: string; category: CostCategory; usd: number; units: number; days: Set<string> }
    >();
    for (const e of this.windowEntries()) {
      for (const d of e.top ?? []) {
        const key = `${e.category}|${d.id}`;
        const cur = acc.get(key) ?? {
          id: d.id,
          category: e.category,
          usd: 0,
          units: 0,
          days: new Set<string>(),
        };
        cur.usd += d.usd;
        cur.units += d.units;
        cur.days.add(e.day);
        acc.set(key, cur);
      }
    }
    return [...acc.values()]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 12)
      .map((d) => ({ ...d, dayCount: d.days.size }));
  });

  /** Wolumen per kategoria w oknie — „$0 do limitu" wymaga pokazania, ile z limitu zjedliśmy. */
  protected readonly volumes = computed(() => {
    interface Volume {
      category: CostCategory;
      usd: number;
      units: number;
      unit: string;
      tokensIn: number;
      tokensOut: number;
      estimated: boolean;
    }
    const acc = new Map<CostCategory, Volume>();
    for (const e of this.windowEntries()) {
      const cur = acc.get(e.category) ?? {
        category: e.category,
        usd: 0,
        units: 0,
        unit: e.unit,
        tokensIn: 0,
        tokensOut: 0,
        estimated: false,
      };
      cur.usd += e.usd;
      cur.units += e.units;
      cur.tokensIn += e.tokensIn ?? 0;
      cur.tokensOut += e.tokensOut ?? 0;
      cur.estimated ||= e.estimated;
      acc.set(e.category, cur);
    }
    // kolejność stała (ALL_CATEGORIES), żeby wiersze nie skakały przy zmianie zakresu
    return ALL_CATEGORIES.map((c) => acc.get(c)).filter((v): v is Volume => Boolean(v));
  });

  // ---------------- wykres ----------------

  /** Skala osi Y: krok z rodziny 1/2/2.5/5, maksimum = wielokrotność kroku nad najwyższym dniem. */
  protected readonly scale = computed(() => {
    const top = Math.max(
      ...this.columns().map((c) =>
        SERIES.filter((s) => !this.isHidden(s)).reduce((n, s) => n + c.bySeries[s], 0),
      ),
      this.budgetPerDay(),
      0,
    );
    const target = Math.max(top * 1.08, 0.0001);
    const step = niceStep(target / 4);
    const max = Math.max(Math.ceil(target / step) * step, step);
    const ticks: { value: number; y: number }[] = [];
    for (let v = 0; v <= max + step / 1000; v += step) {
      ticks.push({ value: v, y: PAD.top + PLOT_H - (v / max) * PLOT_H });
    }
    return { max, ticks };
  });

  protected readonly yMax = computed(() => this.scale().max);
  protected readonly yTicks = computed(() => this.scale().ticks);

  protected readonly budgetLine = computed(() => {
    const y = PAD.top + PLOT_H - (this.budgetPerDay() / this.yMax()) * PLOT_H;
    return { y, x1: PAD.left, x2: PAD.left + PLOT_W, value: this.budgetPerDay() };
  });

  protected readonly band = computed(() => PLOT_W / Math.max(this.columns().length, 1));

  protected readonly barWidth = computed(() => Math.max(3, Math.min(MAX_BAR_W, this.band() - 6)));

  protected readonly segments = computed<Segment[]>(() => {
    const cols = this.columns();
    const band = this.band();
    const w = this.barWidth();
    const max = this.yMax();
    const out: Segment[] = [];

    for (const [i, col] of cols.entries()) {
      const x = PAD.left + band * i + (band - w) / 2;
      const visible = SERIES.filter((s) => !this.isHidden(s) && col.bySeries[s] > 0);
      const topSeries = visible.at(-1);
      // kursor idzie od baseline w górę; przerwa siedzi na GÓRZE segmentu, więc oddziela
      // go od kolejnego, a najwyższy segment jej nie dostaje (nie ma nad sobą sąsiada)
      let cursor = PAD.top + PLOT_H;

      for (const s of visible) {
        const raw = (col.bySeries[s] / max) * PLOT_H;
        const isTop = s === topSeries;
        const gap = isTop ? 0 : SEG_GAP;
        const top = cursor - raw;
        const y = top + gap;
        const h = Math.max(raw - gap, 1.5);
        const entries = col.entries.filter((e) => seriesOf(e.category) === s);
        out.push({
          day: col.day,
          series: s,
          label: SERIES_LABEL(s),
          path: barPath(x, y, w, h, isTop),
          color: this.seriesColor(s),
          usd: col.bySeries[s],
          volume: entries.map((e) => fmtUnits(e.units, e.unit)).join(' · '),
          estimated: entries.every((e) => e.estimated),
          inferred: entries.some((e) => e.inferred),
          // dymek jest wyśrodkowany na segmencie, więc przy krawędziach trzeba go
          // dociągnąć do środka — inaczej pierwszy i ostatni dzień wychodzą poza kartę
          tipX: Math.min(90, Math.max(10, ((x + w / 2) / VIEW_W) * 100)),
          tipY: (y / VIEW_H) * 100,
        });
        cursor = top;
      }
    }
    return out;
  });

  /**
   * Podpisy osi X — co n-ty dzień. Ostatni dzień podpisujemy zawsze (to on jest „dziś"),
   * ale wtedy trzeba usunąć podpis z rytmu, który stanąłby mu na głowie: sam co-n-ty krok
   * plus wymuszony koniec dawał przy 90 dniach dwie etykiety obok siebie.
   */
  protected readonly xLabels = computed(() => {
    const cols = this.columns();
    const band = this.band();
    const last = cols.length - 1;
    const every = Math.max(1, Math.ceil(cols.length / 12));
    const idx = cols.map((_, i) => i).filter((i) => i % every === 0 && last - i >= every / 2);
    if (last >= 0) idx.push(last);
    return idx.map((i) => ({
      x: PAD.left + band * i + band / 2,
      y: PAD.top + PLOT_H + 18,
      text: (cols[i]?.day ?? '').slice(5).replace('-', '.'),
    }));
  });

  protected readonly viewBox = `0 0 ${VIEW_W} ${VIEW_H}`;
  protected readonly plot = { ...PAD, w: PLOT_W, h: PLOT_H, bottom: PAD.top + PLOT_H };

  /**
   * Przygaszamy pozostałe DNI, nie pozostałe segmenty. Stos czyta się w pionie — gdyby
   * gasły też sąsiednie segmenty tego samego dnia, najechanie na „LLM · tekst" ukrywałoby
   * kontekst, w którym ta kwota ma jakiekolwiek znaczenie.
   */
  protected isDim(seg: Segment): boolean {
    const h = this.hover();
    return Boolean(h) && h?.day !== seg.day;
  }

  protected runLink(r: { run: string; stage: CostEntry['stage'] }): string[] {
    return r.stage === 'discover' ? ['/discovery', r.run] : ['/run', r.run];
  }
}
