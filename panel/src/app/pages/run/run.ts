import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import {
  ALL_STATUSES,
  STATUS_META,
  fmtDateTime,
  fmtMs,
  fmtNum,
  fmtTokens,
  fmtUsd,
} from '../../format';
import type { SourceRun, SourceStatus } from '../../types';

type SortKey = 'name' | 'town' | 'status' | 'events' | 'chars' | 'costUsd' | 'ms' | 'followups';

const ACCESSORS: Record<SortKey, (r: SourceRun) => string | number> = {
  name: (r) => r.name.toLowerCase(),
  town: (r) => r.town.toLowerCase(),
  status: (r) => r.status,
  events: (r) => r.events,
  chars: (r) => r.chars ?? -1,
  costUsd: (r) => r.llm.costUsd,
  ms: (r) => r.ms,
  followups: (r) => r.followups.length,
};

@Component({
  selector: 'app-run',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './run.html',
  styleUrl: './run.less',
})
export class RunPage {
  /** startedAt of the run (router param, bound via withComponentInputBinding). */
  readonly runId = input.required<string>();
  /** Optional status pre-filter from query params. */
  readonly status = input<string>();

  protected readonly data = inject(DataService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly statusMeta = STATUS_META;
  protected readonly statuses = ALL_STATUSES;

  protected readonly run = computed(() => this.data.runByStartedAt(this.runId()));

  /** Pre-filled from the ?status= query param; user clicks take over afterwards. */
  protected readonly statusFilter = linkedSignal<SourceStatus | 'all'>(() => {
    const s = this.status();
    return s && (ALL_STATUSES as readonly string[]).includes(s) ? (s as SourceStatus) : 'all';
  });

  protected readonly search = signal('');
  protected readonly sortKey = signal<SortKey>('events');
  protected readonly sortDir = signal<1 | -1>(-1);

  protected readonly rows = computed(() => {
    const run = this.run();
    if (!run) return [];
    const filter = this.statusFilter();
    const q = this.search().trim().toLowerCase();
    const key = this.sortKey();
    const dir = this.sortDir();
    const acc = ACCESSORS[key];
    return run.sources
      .filter((s) => filter === 'all' || s.status === filter)
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.town.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.url.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const va = acc(a);
        const vb = acc(b);
        if (va === vb) return a.name.localeCompare(b.name);
        return (va < vb ? -1 : 1) * dir;
      });
  });

  protected countFor(status: SourceStatus | 'all'): number {
    const run = this.run();
    if (!run) return 0;
    if (status === 'all') return run.sources.length;
    return run.sources.filter((s) => s.status === status).length;
  }

  protected sortBy(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 1 ? -1 : 1));
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === 'name' || key === 'town' || key === 'status' ? 1 : -1);
    }
  }

  protected sortIcon(key: SortKey): string {
    if (this.sortKey() !== key) return '';
    return this.sortDir() === 1 ? '▲' : '▼';
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
}
