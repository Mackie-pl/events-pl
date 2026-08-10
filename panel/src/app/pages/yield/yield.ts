import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, TuiIcon, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import { fmtDateTime, fmtUsd } from '../../format';
import type { YieldSource } from '../../types';

/**
 * Po czym sortujemy — i to jest treść tej strony, nie same liczby.
 *
 *   waste  — ile poszło na przebiegi, z których nic nie wróciło. Domyślne.
 *   yield  — najniższy plon na przebieg: źródło działa, ale prawie nic nie wnosi.
 *   errors — najwięcej przebiegów zakończonych błędem (osobna diagnoza niż „pusto").
 */
export type SortKey = 'waste' | 'yield' | 'errors';

const SORTS: readonly { key: SortKey; label: string; hint: string }[] = [
  { key: 'waste', label: 'Marnotrawstwo', hint: 'najwięcej $ za przebiegi z zerem wydarzeń' },
  { key: 'yield', label: 'Najniższy plon', hint: 'najmniej wydarzeń na jeden przebieg' },
  { key: 'errors', label: 'Błędy', hint: 'najwięcej przebiegów zakończonych błędem' },
];

const yieldOf = (s: YieldSource): number => (s.runs ? s.events / s.runs : 0);

@Component({
  selector: 'app-yield',
  imports: [TuiButton, TuiIcon, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './yield.html',
  styleUrl: './yield.less',
})
export class YieldPage {
  protected readonly data = inject(DataService);

  protected readonly usd = fmtUsd;
  protected readonly dt = fmtDateTime;
  protected readonly sorts = SORTS;
  protected readonly perRun = yieldOf;

  protected readonly sort = signal<SortKey>('waste');
  /** Źródła bez ani jednego wydarzenia to sedno strony — reszta bywa tylko tłem. */
  protected readonly onlyProblems = signal(false);

  constructor() {
    this.data.requestYield();
  }

  protected readonly report = computed(() => this.data.yield.value());

  protected readonly chronic = computed(() => new Set(this.report()?.totals.chronic ?? []));

  protected readonly rows = computed<YieldSource[]>(() => {
    const all = this.report()?.sources ?? [];
    const rows = this.onlyProblems() ? all.filter((s) => s.events === 0) : all;
    const key = this.sort();
    return [...rows].sort((a, b) => {
      if (key === 'yield') return yieldOf(a) - yieldOf(b) || b.costUsd - a.costUsd;
      if (key === 'errors') return b.errorRuns - a.errorRuns || b.costUsd - a.costUsd;
      return b.zeroYieldCostUsd - a.zeroYieldCostUsd || yieldOf(a) - yieldOf(b);
    });
  });

  protected readonly emptyCount = computed(
    () => (this.report()?.sources ?? []).filter((s) => s.events === 0).length,
  );
}
