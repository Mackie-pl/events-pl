import { Component, computed, inject } from '@angular/core';
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
import type { RunReport, SourceStatus } from '../../types';

@Component({
  selector: 'app-overview',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './overview.html',
  styleUrl: './overview.less',
})
export class OverviewPage {
  protected readonly data = inject(DataService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly statusMeta = STATUS_META;
  protected readonly statuses = ALL_STATUSES;

  protected readonly latest = this.data.latest;
  protected readonly runs = this.data.runsDesc;
  protected readonly errors = computed(() => this.data.events.value().errors);
  protected readonly generated = computed(() => this.data.events.value().generated);
  protected readonly eventCount = computed(() => this.data.events.value().events.length);
  protected readonly noiseCount = computed(
    () => this.data.events.value().events.filter((e) => e.is_noise).length,
  );

  protected statusCount(run: RunReport, status: SourceStatus): number {
    switch (status) {
      case 'ok':
        return run.totals.ok;
      case 'unchanged':
        return run.totals.unchanged;
      case 'error':
        return run.totals.errors;
      case 'skipped-fb':
        return run.totals.skippedFb;
      case 'empty':
        return run.totals.empty;
    }
  }
}
