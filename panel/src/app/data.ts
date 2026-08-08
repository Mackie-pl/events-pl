import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

import { BridgeService } from './bridge';
import type {
  CostLedger,
  DiscoverRunReport,
  EventsFile,
  ReuseReport,
  RunReport,
  RunTrail,
  SourceTrail,
  SourcesFile,
} from './types';

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
    searchPerQuery: 0.005,
    storagePerGbMonth: 0,
    scrapePerFetch: 0,
    monthlyBudgetUsd: 15,
  },
  retentionDays: 90,
  entries: [],
};

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly bridge = inject(BridgeService);

  /**
   * Skąd czytamy dane: z drzewa roboczego (lokalny most) czy z gałęzi `main` na GitHubie.
   *
   * Domyślnie GitHub, bo wdrożony panel innego źródła nie ma. Gdy jednak stoi `panel-server`,
   * pliki idą z niego — przebieg puszczony lokalnie był wcześniej niewidoczny aż do commita
   * i pusha, więc iteracja nad discovery wyglądała jak „zatwierdź, żeby zobaczyć, co zatwierdzasz".
   *
   * `null` znaczy „jeszcze nie wiadomo" i celowo WSTRZYMUJE pobrania: httpResource z adresem
   * undefined nie wysyła żądania. Inaczej każdy plik leciałby dwa razy — najpierw z GitHuba,
   * potem z mostu — a użytkownik zdążyłby zobaczyć nieaktualne dane i im uwierzyć.
   */
  private readonly fileBase = computed<string | null>(() => {
    const up = this.bridge.available();
    if (up === null) return null;
    return up && this.bridge.servesFiles() ? `${this.bridge.base}/file` : RAW_BASE;
  });

  /** Czy patrzymy na stan lokalny — panel to pokazuje, żeby nikt nie mylił go z opublikowanym. */
  readonly local = computed(() => this.fileBase() !== null && this.fileBase() !== RAW_BASE);

  private file(name: string): string | undefined {
    const base = this.fileBase();
    if (base === null) return undefined;
    return base === RAW_BASE ? `${RAW_BASE}/${name}` : `${base}?name=${name}`;
  }

  readonly runs = httpResource<RunReport[]>(() => this.file('runs.json'), {
    defaultValue: [],
  });

  readonly events = httpResource<EventsFile>(() => this.file('events.json'), {
    defaultValue: EMPTY_EVENTS,
  });

  readonly sources = httpResource<SourcesFile | null>(() => this.file('sources.json'), {
    defaultValue: null,
  });

  /** Stage 1 (miesięczny): skąd wzięły się źródła w rejestrze. */
  readonly discoverRuns = httpResource<DiscoverRunReport[]>(() => this.file('discover-runs.json'), {
    defaultValue: [],
  });

  /**
   * Księga kosztów obu etapów (90 dni). Osobny plik od raportów przebiegów, bo trend
   * wydatków ma sens dopiero w skali miesiąca, a runs.json trzyma tylko 7 dni szczegółów.
   */
  readonly costs = httpResource<CostLedger>(() => this.file('costs.json'), {
    defaultValue: EMPTY_LEDGER,
  });

  /**
   * Pomiar powtarzalności treści (`npm run measure-reuse`). Jak audit.json: potrzebny
   * wyłącznie na własnej zakładce, więc pobranie startuje dopiero, gdy ta o niego poprosi.
   * Plik powstaje na żądanie, nie w cronie — jego brak jest normalnym stanem, nie awarią.
   */
  private readonly reuseRequested = signal(false);

  readonly reuse = httpResource<ReuseReport | null>(
    () => (this.reuseRequested() ? this.file('reuse.json') : undefined),
    { defaultValue: null },
  );

  requestReuse(): void {
    this.reuseRequested.set(true);
  }

  /**
   * Ślad decyzyjny. Największy plik w zestawie, a potrzebny tylko wtedy, gdy ktoś schodzi
   * do konkretnego źródła — więc URL jest `undefined`, dopóki strona o niego nie poprosi.
   * httpResource z undefined nie wysyła żądania, a przełączenie sygnału startuje pobranie.
   */
  private readonly auditRequested = signal(false);

  readonly audit = httpResource<RunTrail[]>(
    () => (this.auditRequested() ? this.file('audit.json') : undefined),
    { defaultValue: [] },
  );

  requestAudit(): void {
    this.auditRequested.set(true);
  }

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
      // dopóki nie wiemy, skąd czytać, żaden zasób nie wystartował — ale to nadal ładowanie,
      // a nie „brak danych"; bez tego strony mrugają pustym stanem przed pierwszym żądaniem
      this.fileBase() === null ||
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

  /** Ślad jednego źródła w jednym przebiegu; brak = przebieg sprzed audit.json albo źródło milczało. */
  trailFor(startedAt: string, sourceId: string): SourceTrail | undefined {
    // `defaultValue` obsługuje stan ŁADOWANIA, nie BŁĘDU: na zasobie w błędzie `.value()` rzuca.
    // A audit.json pojawia się w repo dopiero po pierwszym przebiegu z tą wersją potoku, więc
    // do tego czasu raw.githubusercontent odpowiada 404 — i wyjątek leci w środku detekcji zmian,
    // wywracając CAŁĄ stronę źródła, nie samą sekcję śladu.
    if (this.audit.error()) return undefined;
    return this.audit
      .value()
      .find((t) => t.run === startedAt)
      ?.sources.find((s) => s.id === sourceId);
  }

  reloadAll(): void {
    this.runs.reload();
    this.events.reload();
    this.sources.reload();
    this.discoverRuns.reload();
    this.costs.reload();
    this.audit.reload();
  }
}
