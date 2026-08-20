import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import {
  ALL_STATUSES,
  FB_VERDICT_META,
  STATUS_META,
  fmtDateTime,
  fmtMs,
  fmtNum,
  fmtTokens,
  fmtUsd,
  runSpend,
} from '../../format';
import { RUN_SCOPE } from '../../types';
import type { FbValueRow, SourceRun, SourceStatus } from '../../types';

/**
 * Kolejność werdyktów regulatora budżetu na ekranie: najpierw to, co CHODZI, potem to, co
 * wypadło. Wewnątrz grupy decyduje pozycja w kolejce wartości, więc linia cięcia jest widoczna
 * jako miejsce, w którym „w budżecie" przechodzi w „poza budżetem" — bez czytania liczb.
 */
const VERDICT_ORDER: readonly string[] = [
  'keep', 'town-floor', 'probation', 'muted', 'over-ceiling', 'too-few-runs', 'no-threshold',
];

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
  protected readonly verdictMeta = FB_VERDICT_META;

  protected readonly run = computed(() => this.data.runByStartedAt(this.runId()));

  /**
   * Rachunek przebiegu z jego wpisów księgi. `totals.costUsd` zna wyłącznie OpenRouter,
   * więc nagłówek podawał kwotę mniejszą od tej, którą ten sam dzień pokazuje w Money.
   */
  protected readonly spend = computed(() => {
    const run = this.run();
    return run ? runSpend(run) : null;
  });

  constructor() {
    // decyzje spoza pojedynczego źródła (scalanie, redakcja, publikacja) siedzą w audit.json
    this.data.requestAudit();
  }

  /**
   * Kolejka wartości kanału FB, posortowana tak, jak zapadały decyzje. Pusta dla przebiegów
   * sprzed regulatora i dla tych bez ani jednego źródła FB.
   */
  protected readonly fbQueue = computed<FbValueRow[]>(() =>
    [...(this.run()?.fbValue ?? [])].sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) ||
        (a.rank ?? 9999) - (b.rank ?? 9999) ||
        a.id.localeCompare(b.id),
    ),
  );

  /**
   * Czy ten przebieg niesie w ogóle kolejkę wartości. Przebiegi sprzed regulatora (do
   * 2026-08-17) mają werdykty, ale nie mają pozycji ani kosztu pobrania — a wtedy „ostatnie
   * przyjęte" wychodzi z sortowania alfabetycznego i jest liczbą wziętą z sufitu.
   * Lepiej powiedzieć „nie wiadomo" niż pokazać wiarygodnie wyglądającą nieprawdę.
   */
  protected readonly hasRanking = computed(() =>
    this.fbQueue().some((r) => r.rank !== undefined),
  );

  /** Cena źródła BRZEGOWEGO — próg, który wyszedł z budżetu, zamiast być zgadnięty. */
  protected readonly marginalUsd = computed<number | null>(() => {
    if (!this.hasRanking()) return null;
    const kept = this.fbQueue().filter((r) => r.verdict === 'keep');
    return kept[kept.length - 1]?.usdPerNovel ?? null;
  });

  /** Werdykty, po których źródło ma prawo pobierać w tym przebiegu. */
  private readonly admitted = computed(() =>
    this.fbQueue().filter(
      (r) => r.verdict === 'keep' || r.verdict === 'town-floor' || r.verdict === 'probation',
    ),
  );

  /**
   * PROGNOZA, nie rachunek: suma `usdPerFetch` dopuszczonych źródeł, a `usdPerFetch` to średnia
   * z poprzednich przebiegów (albo sufit `limit × stawka` dla nigdy niepobieranych). Etykieta
   * mówiła „pobrania kosztują X na przebieg" i wyglądała jak kwota — 2026-08-20 dawała $0.299,
   * gdy realny rachunek kanału wyniósł $0.255, bo 6 z 10 dopuszczonych źródeł w ogóle nie
   * pobrało. To nie jest usterka regulatora: budżet rezerwuje się przed pobraniem.
   */
  protected readonly fbForecastUsd = computed(() =>
    this.admitted().reduce((n, r) => n + (r.usdPerFetch ?? 0), 0),
  );

  protected readonly fbAdmittedCount = computed(() => this.admitted().length);

  /** Ile z dopuszczonych naprawdę pobrało — różnica z prognozą ma być widoczna, nie domyślna. */
  protected readonly fbFetchedCount = computed(() => {
    const withRecords = new Set(
      (this.run()?.sources ?? []).filter((s) => s.bd?.records).map((s) => s.id),
    );
    return this.admitted().filter((r) => withRecords.has(r.id)).length;
  });

  /** Rachunek kanału FB z księgi tego przebiegu: wolumen × stawka, ta sama liczba co w Money. */
  protected readonly fbActualUsd = computed(() => this.spend()?.fb ?? 0);

  /** Rekordy Bright Data kupione w tym przebiegu — wolumen stojący za kwotą wyżej. */
  protected readonly fbRecords = computed(() => this.run()?.brightdata?.records ?? 0);

  /** Kroki zakresu przebiegu — nie należą do żadnego źródła, więc nie ma ich na stronie źródła. */
  protected readonly runSteps = computed(
    () => this.data.trailFor(this.runId(), RUN_SCOPE)?.steps ?? [],
  );

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
