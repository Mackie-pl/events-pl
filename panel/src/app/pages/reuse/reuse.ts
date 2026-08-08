import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, TuiIcon, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { BridgeService } from '../../bridge';
import { DataService } from '../../data';
import { fmtDateTime, fmtNum, fmtUsd } from '../../format';
import type { ReuseSamples, ReuseSource } from '../../types';

/**
 * Po czym sortujemy tabelę — i to jest właściwa treść tej strony, nie same liczby.
 *
 *   waste  — ile ten serwis kosztuje za treść, którą już mamy. Domyślne: od tego się zaczyna.
 *   gap    — sufit minus odzysk, czyli ile gubi NASZ podział na bloki. Kandydaci na
 *            segmentację po DOM-ie stoją tu na górze.
 *   churn  — najniższy sufit, czyli strony, które naprawdę zmieniają się w całości.
 *            Tu żaden cache nie pomoże i trzeba pytać, czemu treść jest za każdym razem inna.
 */
export type SortKey = 'waste' | 'gap' | 'churn';

const SORTS: readonly { key: SortKey; label: string; hint: string }[] = [
  { key: 'waste', label: 'Marnotrawstwo', hint: 'najwięcej pieniędzy za znaną treść' },
  { key: 'gap', label: 'Luka segmentacji', hint: 'sufit wysoko, odzysk nisko — nasz podział gubi' },
  { key: 'churn', label: 'Prawdziwa zmienność', hint: 'najniższy sufit — strona zmienia się cała' },
];

const wasteOf = (s: ReuseSource): number => s.freeUsd + s.shrinkUsd;
const gapOf = (s: ReuseSource): number => s.ceiling - s.reuse;

@Component({
  selector: 'app-reuse',
  imports: [TuiButton, TuiIcon, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './reuse.html',
  styleUrl: './reuse.less',
})
export class ReusePage {
  protected readonly data = inject(DataService);
  protected readonly bridge = inject(BridgeService);

  protected readonly usd = fmtUsd;
  protected readonly num = fmtNum;
  protected readonly dt = fmtDateTime;
  protected readonly sorts = SORTS;
  protected readonly gap = gapOf;

  protected readonly sort = signal<SortKey>('waste');
  /** Followupy to 3/4 wierszy i osobna historia — domyślnie zwinięte, ale nie ukryte na stałe. */
  protected readonly showFollowups = signal(false);
  protected readonly opened = signal<string | null>(null);

  constructor() {
    this.data.requestReuse();
  }

  protected readonly report = computed(() => this.data.reuse.value());
  protected readonly totals = computed(() => this.report()?.totals);

  protected readonly rows = computed<ReuseSource[]>(() => {
    const all = this.report()?.sources ?? [];
    const rows = this.showFollowups() ? all : all.filter((s) => !s.followup);
    const key = this.sort();
    return [...rows].sort((a, b) => {
      if (key === 'gap') return gapOf(b) - gapOf(a);
      if (key === 'churn') return a.ceiling - b.ceiling;
      return wasteOf(b) - wasteOf(a) || b.chars - a.chars;
    });
  });

  protected readonly followupCount = computed(
    () => (this.report()?.sources ?? []).filter((s) => s.followup).length,
  );

  /** Procent z jednym miejscem — w tabeli chodzi o rząd wielkości, nie o dokładność. */
  protected pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
  }

  protected toggle(id: string): void {
    this.opened.set(this.opened() === id ? null : id);
    this.samples.set(null);
  }

  // ---------------- przykłady z prywatnego archiwum ----------------

  protected readonly samples = signal<ReuseSamples | null>(null);
  protected readonly samplesLoading = signal(false);
  protected readonly samplesError = signal<string | null>(null);

  /**
   * Fragmenty, które mimo cache'a poszłyby do modelu. Nie ma ich w repo i nie będzie:
   * to cudza treść bez redakcji PII, więc leży w prywatnym buckecie i przychodzi wyłącznie
   * przez most na localhoście. Wdrożony panel pokazuje w tym miejscu wyjaśnienie.
   */
  protected loadSamples(path: string): void {
    this.samples.set(null);
    this.samplesError.set(null);
    this.samplesLoading.set(true);
    this.bridge.objectJson<ReuseSamples>(path).subscribe((s) => {
      this.samplesLoading.set(false);
      if (s === null) {
        this.samplesError.set(
          `Nie udało się pobrać ${path} — sprawdź, czy most ma SUPABASE_* w .env ` +
            'i czy pomiar był puszczony po ostatniej zmianie okna.',
        );
        return;
      }
      this.samples.set(s);
    });
  }
}
