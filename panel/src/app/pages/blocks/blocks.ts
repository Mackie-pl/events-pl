import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import { fmtDateTime, fmtNum, fmtUsd } from '../../format';

import {
  type RunWaste, type WasteRow, aggregateWaste, chronicOf, share, silentShareOf, wastedUsdOf,
} from './waste';

/**
 * Po czym sortujemy — i to jest treść tej strony, nie same liczby.
 *
 *   usd    — ile pieniędzy poszło na jałowe bloki. Domyślne: od tego się zaczyna.
 *   share  — jaki UDZIAŁ świeżej treści milczy. Tanie źródło z udziałem 100% jest
 *            kandydatem na poprawkę podziału, choć w kolumnie $ stoi nisko.
 *   volume — najwięcej jałowych znaków w sztukach: gdzie w ogóle jest masa do odzyskania.
 */
export type SortKey = 'usd' | 'share' | 'volume';

const SORTS: readonly { key: SortKey; label: string; hint: string }[] = [
  { key: 'usd', label: 'Marnotrawstwo', hint: 'najwięcej ~$ za bloki bez wydarzeń' },
  { key: 'share', label: 'Udział jałowych', hint: 'jaka część świeżej treści milczy' },
  { key: 'volume', label: 'Objętość', hint: 'najwięcej jałowych znaków' },
];

@Component({
  selector: 'app-blocks',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './blocks.html',
  styleUrl: './blocks.less',
})
export class BlocksPage {
  protected readonly data = inject(DataService);

  protected readonly usd = fmtUsd;
  protected readonly num = fmtNum;
  protected readonly dt = fmtDateTime;
  protected readonly sorts = SORTS;
  protected readonly wasted = wastedUsdOf;

  protected readonly sort = signal<SortKey>('usd');
  /** Źródła, w których model nie znalazł nic ani razu — sedno strony, ale nie całość. */
  protected readonly onlyChronic = signal(false);
  protected readonly opened = signal<string | null>(null);

  constructor() {
    this.data.requestAudit();
  }

  protected readonly all = computed<WasteRow[]>(() =>
    this.data.audit.error() ? [] : aggregateWaste(this.data.audit.value()),
  );

  protected readonly chronic = computed(() => new Set(chronicOf(this.all()).map((r) => r.id)));

  protected readonly rows = computed<WasteRow[]>(() => {
    const chronic = this.chronic();
    const rows = this.onlyChronic() ? this.all().filter((r) => chronic.has(r.id)) : this.all();
    const key = this.sort();
    return [...rows].sort((a, b) => {
      if (key === 'share') return silentShareOf(b) - silentShareOf(a) || b.usd - a.usd;
      if (key === 'volume') return b.silentChars - a.silentChars;
      return b.wastedUsd - a.wastedUsd || silentShareOf(b) - silentShareOf(a);
    });
  });

  /** Okno śladu: tyle przebiegów, ile trzyma audit.json — krócej niż runs.json i celowo. */
  protected readonly window = computed(() => {
    const days = this.data.audit.value().map((t) => t.day);
    return { from: days[0] ?? '', to: days[days.length - 1] ?? '', runs: days.length };
  });

  protected readonly totals = computed(() => {
    const rows = this.all();
    const sum = (pick: (r: WasteRow) => number): number => rows.reduce((n, r) => n + pick(r), 0);
    return {
      sources: rows.length,
      fresh: sum((r) => r.fresh),
      silent: sum((r) => r.silent),
      freshChars: sum((r) => r.freshChars),
      measuredChars: sum((r) => r.measuredChars),
      silentChars: sum((r) => r.silentChars),
      silentLeads: sum((r) => r.silentLeads),
      usd: sum((r) => r.usd),
      wastedUsd: sum((r) => r.wastedUsd),
      runs: sum((r) => r.runs.length),
      unmeasured: sum((r) => r.unmeasured),
    };
  });

  /**
   * Czy w oknie jest CHOĆ JEDEN przebieg z pomiarem znaków.
   *
   * Bez tego strona kłamie najgorzej, jak umie: ślad sprzed pomiaru daje same zera, więc
   * kafelek pokazywałby „~$0 · 0.0% znaków bez wydarzenia" — czyli dokładnie to samo, co
   * potok, któremu nic się nie marnuje. Puste miejsce mówi „nie wiem", a zero mówi „wiem,
   * że nic"; tylko jedno z tego jest prawdą.
   */
  protected readonly charsKnown = computed(() => this.totals().unmeasured < this.totals().runs);

  /** To samo pytanie o jedno źródło — wiersz w pełni niezmierzony pokazuje kreski, nie zera. */
  protected known(r: WasteRow): boolean {
    return r.unmeasured < r.runs.length;
  }

  protected readonly silentShare = silentShareOf;

  /** Udział w JEDNYM przebiegu — tam mianownikiem jest po prostu to, co poszło do modelu. */
  protected runShare(w: RunWaste): number {
    return share(w.silentChars, w.freshChars);
  }

  /** Procent z jednym miejscem — w tabeli chodzi o rząd wielkości, nie o dokładność. */
  protected pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
  }

  protected toggle(id: string): void {
    this.opened.set(this.opened() === id ? null : id);
  }
}
