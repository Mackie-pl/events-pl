import { httpResource } from '@angular/common/http';
import { Injectable, computed } from '@angular/core';

import type { CostLedger, DiscoverRunReport, EventsFile, RunReport, SourcesFile } from './types';

/** Raw GitHub serves fresh JSON (CDN cache ~5 min) with permissive CORS. */
const RAW_BASE = 'https://raw.githubusercontent.com/Mackie-pl/events-pl/main';

const EMPTY_EVENTS: EventsFile = { generated: '', events: [], errors: [] };

/**
 * Księga sprzed pierwszego przebiegu z kosztami. Stawki to te same domyślne, co w src/cost.ts —
 * panel czyta je z pliku, więc ta kopia służy wyłącznie do wyrenderowania pustego stanu.
 */
const EMPTY_LEDGER: CostLedger = {
  updated: '',
  rates: {
    bdPerRecord: 0.0015,
    bravePerQuery: 0,
    storagePerGbMonth: 0,
    scrapePerFetch: 0,
    monthlyBudgetUsd: 15,
  },
  retentionDays: 90,
  entries: [],
};

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

  /** Stage 1 (miesięczny): skąd wzięły się źródła w rejestrze. */
  readonly discoverRuns = httpResource<DiscoverRunReport[]>(
    () => `${RAW_BASE}/discover-runs.json`,
    { defaultValue: [] },
  );

  /**
   * Księga kosztów obu etapów (90 dni). Osobny plik od raportów przebiegów, bo trend
   * wydatków ma sens dopiero w skali miesiąca, a runs.json trzyma tylko 7 dni szczegółów.
   */
  readonly costs = httpResource<CostLedger>(() => `${RAW_BASE}/costs.json`, {
    defaultValue: EMPTY_LEDGER,
  });

  /** Newest first. */
  readonly runsDesc = computed(() =>
    [...this.runs.value()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );

  readonly discoverRunsDesc = computed(() =>
    [...this.discoverRuns.value()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );

  readonly latest = computed<RunReport | undefined>(() => this.runsDesc()[0]);

  readonly latestDiscover = computed<DiscoverRunReport | undefined>(
    () => this.discoverRunsDesc()[0],
  );

  readonly loading = computed(
    () =>
      this.runs.isLoading() ||
      this.events.isLoading() ||
      this.sources.isLoading() ||
      this.discoverRuns.isLoading() ||
      this.costs.isLoading(),
  );

  runByStartedAt(startedAt: string): RunReport | undefined {
    return this.runs.value().find((r) => r.startedAt === startedAt);
  }

  discoverRunByStartedAt(startedAt: string): DiscoverRunReport | undefined {
    return this.discoverRuns.value().find((r) => r.startedAt === startedAt);
  }

  /** Źródło z rejestru po id — proweniencja żyje właśnie tutaj, nie w przebiegu. */
  sourceById(id: string) {
    return this.sources.value()?.sources.find((s) => s.id === id);
  }

  isLatest(startedAt: string): boolean {
    return this.latest()?.startedAt === startedAt;
  }

  reloadAll(): void {
    this.runs.reload();
    this.events.reload();
    this.sources.reload();
    this.discoverRuns.reload();
    this.costs.reload();
  }
}
