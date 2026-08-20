import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import { STATUS_META, fmtDateTime, fmtMs, fmtNum, fmtUsd } from '../../format';
import type { EventItem, RunReport, SourceRun } from '../../types';

/** Jeden przebieg widziany z perspektywy JEDNEGO źródła — para raport + jego wiersz w nim. */
interface HistoryRow {
  run: RunReport;
  s: SourceRun;
  /** rachunek źródła w tym przebiegu: model + rekordy Bright Data po stawce z księgi */
  usd: number;
}

/**
 * Źródło w skali dłuższej niż jeden przebieg.
 *
 * Strona `/run/:runId/source/:sourceId` odpowiada na „co to źródło zrobiło TEGO DNIA" i tak
 * ma zostać — ślad, archiwum i sonda są z natury per-przebieg. Brakowało drugiego pytania:
 * „co to źródło daje w ogóle", czyli historia statusów obok wszystkich wydarzeń, które od
 * niego stoją dziś w rejestrze. Bez tego jedyną drogą było klikanie po kolejnych dniach.
 */
@Component({
  selector: 'app-source-history',
  imports: [RouterLink, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './source-history.html',
  styleUrl: './source-history.less',
})
export class SourceHistoryPage {
  readonly sourceId = input.required<string>();

  protected readonly data = inject(DataService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly statusMeta = STATUS_META;

  /** Wpis rejestru — proweniencja, typ, flagi. Brak = źródło wypadło z sources.json. */
  protected readonly meta = computed(() => this.data.sourceById(this.sourceId()));

  /**
   * Historia w oknie runs.json (7 dni). Przebiegi, w których źródła w ogóle nie było,
   * wypadają — inaczej wiersz „brak" wyglądałby jak status, a to nie to samo.
   */
  protected readonly history = computed<HistoryRow[]>(() => {
    const rate = this.data.costs.value().rates.bdPerRecord;
    const rows: HistoryRow[] = [];
    for (const run of this.data.runsDesc()) {
      const s = run.sources.find((x) => x.id === this.sourceId());
      if (s) rows.push({ run, s, usd: s.llm.costUsd + (s.bd?.records ?? 0) * rate });
    }
    return rows;
  });

  /** Nazwa źródła z najświeższego przebiegu, gdy rejestr go nie zna. */
  protected readonly name = computed(
    () => this.meta()?.name ?? this.history()[0]?.s.name ?? this.sourceId(),
  );

  protected readonly url = computed(() => this.meta()?.url ?? this.history()[0]?.s.url ?? '');

  protected readonly town = computed(() => this.meta()?.town ?? this.history()[0]?.s.town ?? '');

  /**
   * Od kiedy źródło jest w rejestrze. `discovered` bywa znacznikiem sposobu („auto"), nie datą —
   * wtedy pytamy proweniencję o przebieg, który je przyniósł, a gdy i jej nie ma, milczymy.
   * Podpis „w rejestrze od auto" nie jest odpowiedzią na żadne pytanie.
   */
  protected readonly since = computed<string | null>(() => {
    const m = this.meta();
    if (!m) return null;
    const d = m.discovered ?? '';
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const run = m.provenance?.run ?? '';
    return /^\d{4}-\d{2}-\d{2}/.test(run) ? run.slice(0, 10) : null;
  });

  /**
   * Suma z okna runs.json — nie „od zawsze". Raporty starsze niż 7 dni są przycinane,
   * więc etykieta mówi wprost, ile przebiegów stoi za tymi liczbami.
   */
  protected readonly totals = computed(() => {
    const rows = this.history();
    return {
      runs: rows.length,
      // pobrania, czyli przebiegi bez „skipped-*": tylko one mają prawo cokolwiek kosztować
      fetched: rows.filter((r) => !r.s.status.startsWith('skipped')).length,
      events: rows.reduce((n, r) => n + r.s.events, 0),
      usd: rows.reduce((n, r) => n + r.usd, 0),
      errors: rows.filter((r) => r.s.status === 'error').length,
    };
  });

  /**
   * Wydarzenia stojące dziś w rejestrze od tego źródła.
   *
   * To NIE jest pełna historia: `events.json` trzyma stan bieżący, a wydarzenia po terminie
   * z niego wypadają. Odpowiada więc na „co to źródło ma w rejestrze teraz", a nie „co kiedyś
   * dało" — i strona ma to mówić wprost, żeby nikt nie wziął zera za brak plonu.
   */
  protected readonly events = computed<EventItem[]>(() =>
    this.data.events
      .value()
      .events.filter((e) => e.source_id === this.sourceId())
      .sort((a, b) => a.date_start.localeCompare(b.date_start)),
  );

  protected readonly noise = computed(() => this.events().filter((e) => e.is_noise).length);

  protected readonly loading = computed(
    () => this.data.runs.isLoading() || this.data.sources.isLoading(),
  );

  protected price(e: EventItem): string {
    if (e.price.free === true) return 'wstęp wolny';
    if (e.price.amount_pln != null) return `${e.price.amount_pln} PLN`;
    return e.price.note ?? '—';
  }
}
