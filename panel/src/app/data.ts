import { httpResource } from '@angular/common/http';
import { Injectable, computed } from '@angular/core';

import type { EventsFile, RunReport, SourcesFile } from './types';

/** Raw GitHub serves fresh JSON (CDN cache ~5 min) with permissive CORS. */
const RAW_BASE = 'https://raw.githubusercontent.com/Mackie-pl/events-pl/main';

const EMPTY_EVENTS: EventsFile = { generated: '', events: [], errors: [] };

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly runs = httpResource<RunReport[]>(() => `${RAW_BASE}/runs.json`, {
    defaultValue: [],
  });

  readonly events = httpResource<EventsFile>(() => `${RAW_BASE}/events.json`, {
    defaultValue: EMPTY_EVENTS,
  });

  readonly sources = httpResource<SourcesFile | null>(() => `${RAW_BASE}/sources.json`, {
    defaultValue: null,
  });

  /** Newest first. */
  readonly runsDesc = computed(() =>
    [...this.runs.value()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );

  readonly latest = computed<RunReport | undefined>(() => this.runsDesc()[0]);

  readonly loading = computed(
    () => this.runs.isLoading() || this.events.isLoading() || this.sources.isLoading(),
  );

  runByStartedAt(startedAt: string): RunReport | undefined {
    return this.runs.value().find((r) => r.startedAt === startedAt);
  }

  isLatest(startedAt: string): boolean {
    return this.latest()?.startedAt === startedAt;
  }

  reloadAll(): void {
    this.runs.reload();
    this.events.reload();
    this.sources.reload();
  }
}
