import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import { fmtDateTime, fmtMs, fmtNum, fmtProbe, fmtTokens, fmtUsd } from '../../format';
import type { Source } from '../../types';

type Filter = 'all' | 'tracked' | 'untracked' | 'dead';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tracked', label: 'With provenance' },
  { key: 'untracked', label: 'No provenance' },
  { key: 'dead', label: 'Dead' },
];

/**
 * „Dlaczego ten adres jest na liście?" — rejestr źródeł widziany od strony pochodzenia:
 * zapytanie → wynik wyszukiwarki → uzasadnienie modelu → pierwsze pobranie.
 */
@Component({
  selector: 'app-discovery',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './discovery.html',
  styleUrl: './discovery.less',
})
export class DiscoveryPage {
  protected readonly data = inject(DataService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly probe = fmtProbe;
  protected readonly filters = FILTERS;

  protected readonly runs = this.data.discoverRunsDesc;
  protected readonly latest = this.data.latestDiscover;

  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  /** id rozwiniętego źródła — pełna proweniencja nie mieści się w wierszu tabeli */
  protected readonly expanded = signal<string | null>(null);

  private readonly all = computed(() => this.data.sources.value()?.sources ?? []);

  protected readonly tracked = computed(() => this.all().filter((s) => s.provenance).length);

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const f = this.filter();
    return this.all()
      .filter((s) => this.matchesFilter(s, f))
      .filter(
        (s) =>
          !q ||
          s.id.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.url.toLowerCase().includes(q) ||
          s.town.toLowerCase().includes(q) ||
          (s.provenance?.why ?? '').toLowerCase().includes(q) ||
          (s.provenance?.query ?? '').toLowerCase().includes(q),
      );
  });

  private matchesFilter(s: Source, f: Filter): boolean {
    switch (f) {
      case 'all':
        return true;
      case 'tracked':
        return !!s.provenance;
      case 'untracked':
        return !s.provenance;
      case 'dead':
        return !!s.dead;
    }
  }

  protected countFor(f: Filter): number {
    return this.all().filter((s) => this.matchesFilter(s, f)).length;
  }

  protected toggle(id: string): void {
    this.expanded.update((cur) => (cur === id ? null : id));
  }

  /** Przebieg, który dodał źródło — o ile nie wypadł jeszcze z historii. */
  protected runExists(startedAt: string): boolean {
    return !!this.data.discoverRunByStartedAt(startedAt);
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
}
