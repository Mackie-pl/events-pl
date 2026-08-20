import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, type TuiDialogContext, tuiDialog } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { injectContext } from '@taiga-ui/polymorpheus';

import { BridgeService } from '../bridge';
import { fmtDateTime, fmtNum } from '../format';

import { fmtBytes } from './code-lines';
import { CodeView } from './code-view';
import { type RawSnapshotView, rawSnapshotFromJson } from './raw-snapshot';

export interface RawInspectorInput {
  /** Ścieżka zrzutu w prywatnym archiwum (`raw/…json`) — dociągana przez most. */
  path: string;
}

type Tab = 'records' | 'body' | 'raw';

/**
 * Podgląd zrzutu wejścia: co potok naprawdę dostał, zanim cokolwiek z tym zrobił.
 *
 * Powód powstania jest ten sam, co przy inspektorze wywołań modelu, tylko od drugiej strony:
 * migawka Bright Data leży w archiwum jako `text` — czyli CAŁA lista rekordów zaescapowana
 * w jedno pole JSON-a. Wylana jak leci była jedną linią na kilkaset kilobajtów z `\n`
 * w środku; metadane (runId, sourceId, url) widać było od razu, a jedyną rzecz, po którą
 * się tu przychodzi — nie. Tutaj treść wraca do JSON-a, a lista rekordów rozpada się na
 * pozycje, bo pytanie zawsze brzmi „co przyszło w TYM poście", nie „ile to bajtów".
 *
 * Zrzuty są prywatne (cudze treści przed redakcją PII), więc podgląd żyje wyłącznie za
 * lokalnym mostem — wdrożony panel pokazuje w tym miejscu samą ścieżkę.
 */
@Component({
  selector: 'app-raw-inspector',
  imports: [TuiButton, TuiBadge, CodeView],
  templateUrl: './raw-inspector.html',
  styleUrl: './raw-inspector.less',
})
export class RawInspector {
  readonly context = injectContext<TuiDialogContext<void, RawInspectorInput>>();

  private readonly bridge = inject(BridgeService);

  protected readonly num = fmtNum;
  protected readonly dt = fmtDateTime;
  protected readonly bytes = fmtBytes;

  protected readonly snap = signal<RawSnapshotView | null>(null);
  protected readonly loading = signal(false);
  /** Treść, która nie okazała się zrzutem — pokazujemy ją surowo zamiast błędu. */
  protected readonly fallback = signal<string | null>(null);

  protected readonly opened = signal<number | null>(null);

  protected readonly tabs = computed<Tab[]>(() =>
    this.snap()?.records.length ? ['records', 'body', 'raw'] : ['body', 'raw'],
  );

  /** Domyślnie otwiera się to, co daje odpowiedź najszybciej: rekordy, gdy w ogóle są. */
  protected readonly tab = signal<Tab>('body');

  protected readonly tabLabel: Record<Tab, string> = {
    records: 'rekordy',
    body: 'treść',
    raw: 'obiekt archiwum',
  };

  constructor() {
    const { path } = this.context.data;
    this.loading.set(true);
    this.bridge.object(path).subscribe((text) => {
      this.loading.set(false);
      const parsed = rawSnapshotFromJson(text, path);
      if (!parsed) {
        this.fallback.set(text);
        return;
      }
      this.snap.set(parsed);
      if (parsed.records.length) this.tab.set('records');
    });
  }

  protected toggle(i: number): void {
    this.opened.set(this.opened() === i ? null : i);
  }
}

/**
 * Otwieracz podglądu do wstrzyknięcia w polu komponentu — bliźniaczo do `llmInspector()`:
 *
 *   protected readonly inspectRaw = rawInspector();
 *   …
 *   (click)="inspectRaw({ path })"
 */
export function rawInspector(): (input: RawInspectorInput) => void {
  const open = tuiDialog(RawInspector, {
    size: 'l',
    appearance: 'taiga wide',
    label: 'Zrzut wejścia',
  });
  return (input) => {
    open(input).subscribe();
  };
}
