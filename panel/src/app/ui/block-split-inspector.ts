import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, type TuiDialogContext, tuiDialog } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { injectContext } from '@taiga-ui/polymorpheus';

import { BridgeService } from '../bridge';
import { fmtNum } from '../format';

import { CodeView } from './code-view';
import {
  CUT_META, type SplitBlock, type SplitView, splitFromJson, totalsOf,
} from './block-split';

export interface BlockSplitInput {
  /** Ścieżka rozliczenia w prywatnym archiwum (`blocks/…json`) — dociągana przez most. */
  path: string;
}

/** Co pokazujemy z listy — filtr jest tu treścią, nie ozdobą (patrz `FILTERS`). */
type Filter = 'all' | 'cards' | 'rest' | 'fresh' | 'silent';

/**
 * Pytania, które zadaje się temu podglądowi. Każdy filtr to jedno z nich, dlatego nie ma
 * tu „pokaż wszystko oprócz" ani sortowania: kolejność bloków JEST odpowiedzią (tak leży
 * strona), a przestawienie jej zabrałoby jedyną rzecz, której nie widać nigdzie indziej.
 */
const FILTERS: readonly { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'Wszystkie', hint: 'cała strona w kolejności, w jakiej leży' },
  { key: 'cards', label: 'Karty', hint: 'bloki rozpoznane jako karty wydarzeń' },
  { key: 'rest', label: 'Reszta', hint: 'chrom: nagłówki, filtry, menu, stopki treściowe' },
  { key: 'fresh', label: 'Do modelu', hint: 'bloki, za które zapłaciliśmy w tym przebiegu' },
  { key: 'silent', label: 'Jałowe', hint: 'świeże bloki bez ani jednego wydarzenia' },
];

/**
 * Podgląd podziału strony na bloki: co splitter uznał za kartę, gdzie postawił granice
 * i za co dziś zapłaciliśmy.
 *
 * Powód powstania jest konkretny (2026-08-19, okpoznan.pl): blok z listą filtrów pojawiał
 * się w rozliczeniu raz z doklejonym spisem miesięcy, raz bez — i z samego archiwum nie dało
 * się powiedzieć, czy zmieniła się STRONA, czy nasza GRANICA. Odpowiedź (granica, bo hash
 * przestawionej listy partnerów przerzucił `isBoundary`) wymagała odtworzenia podziału
 * osobnym skryptem. Tutaj widać ją wprost: pasek pokazuje, gdzie leżą cięcia, a `cut` mówi,
 * co je postawiło.
 *
 * Rozliczenie jest prywatne (treść cudzych stron), więc podgląd żyje wyłącznie za lokalnym
 * mostem — wdrożony panel pokazuje w tym miejscu samą ścieżkę.
 */
@Component({
  selector: 'app-block-split-inspector',
  imports: [TuiButton, TuiBadge, CodeView],
  templateUrl: './block-split-inspector.html',
  styleUrl: './block-split-inspector.less',
})
export class BlockSplitInspector {
  readonly context = injectContext<TuiDialogContext<void, BlockSplitInput>>();

  private readonly bridge = inject(BridgeService);

  protected readonly num = fmtNum;
  protected readonly cutMeta = CUT_META;
  protected readonly filters = FILTERS;

  protected readonly split = signal<SplitView | null>(null);
  protected readonly loading = signal(false);
  /** Treść, która nie okazała się rozliczeniem podziału — pokazujemy ją surowo zamiast błędu. */
  protected readonly fallback = signal<string | null>(null);

  protected readonly filter = signal<Filter>('all');
  protected readonly opened = signal<number | null>(null);
  protected readonly showRaw = signal(false);

  constructor() {
    const { path } = this.context.data;
    this.loading.set(true);
    this.bridge.object(path).subscribe((text) => {
      this.loading.set(false);
      const parsed = splitFromJson(text, path);
      if (parsed) this.split.set(parsed);
      else this.fallback.set(text);
    });
  }

  protected readonly totals = computed(() => totalsOf(this.split()?.blocks ?? []));

  protected readonly rows = computed<SplitBlock[]>(() => {
    const blocks = this.split()?.blocks ?? [];
    switch (this.filter()) {
      case 'cards': return blocks.filter((b) => b.card);
      case 'rest': return blocks.filter((b) => !b.card);
      case 'fresh': return blocks.filter((b) => b.fresh);
      case 'silent': return blocks.filter((b) => b.fresh && !b.events);
      default: return blocks;
    }
  });

  /**
   * Ile miejsca zajmuje blok na pasku strony. Udział W ZNAKACH, nie równe kafelki — inaczej
   * jedno-wierszowa stopka wygląda tak samo ważnie jak lista wydarzeń na pół dokumentu,
   * a pytanie brzmi właśnie „ile z tej strony to co".
   */
  protected width(b: SplitBlock): string {
    const all = this.totals().chars;
    return `${all ? Math.max(0.4, (b.chars / all) * 100) : 0}%`;
  }

  /** Klasa segmentu paska: karta czy chrom, świeży czy z cache'a, jałowy osobno. */
  protected tone(b: SplitBlock): string {
    if (b.fresh && !b.events) return 'silent';
    if (b.card) return b.fresh ? 'card-fresh' : 'card';
    return b.fresh ? 'rest-fresh' : 'rest';
  }

  protected title(b: SplitBlock): string {
    const state = b.fresh ? 'do modelu' : `z cache${b.since ? ` (od ${b.since})` : ''}`;
    const cut = b.cut ? ` · cięcie: ${CUT_META[b.cut].label}` : '';
    return `#${b.i} · ${b.card ? 'karta' : 'reszta'} · ${b.chars} zn. · ${state}`
      + `${cut} · wydarzeń: ${b.events}`;
  }

  protected toggle(i: number): void {
    this.opened.set(this.opened() === i ? null : i);
  }

  /** Pierwsza linia bloku — tyle, żeby rozpoznać go bez rozwijania. */
  protected head(text: string): string {
    return text.replace(/\s+/gu, ' ').trim().slice(0, 160);
  }
}

/**
 * Otwieracz podglądu do wstrzyknięcia w polu komponentu — bliźniaczo do `llmInspector()`:
 *
 *   protected readonly inspectSplit = blockSplitInspector();
 *   …
 *   (click)="inspectSplit({ path })"
 */
export function blockSplitInspector(): (input: BlockSplitInput) => void {
  const open = tuiDialog(BlockSplitInspector, {
    size: 'l',
    appearance: 'taiga wide',
    label: 'Podział na bloki',
  });
  return (input) => {
    open(input).subscribe();
  };
}
