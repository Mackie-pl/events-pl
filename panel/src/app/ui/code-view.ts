import { Component, computed, input, signal } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';

import { type CodeLang, type CodeLine, LINE_CAP, fmtBytes, toLines } from './code-lines';

/**
 * Blok tekstu do CZYTANIA: numery linii, kolorowanie JSON-a i przełącznik zawijania.
 *
 * Powstał z jednego konkretnego problemu: prompt zapisany w archiwum to jedna linia
 * na kilkadziesiąt tysięcy znaków, a `<pre>` rozpychało nią całą stronę w bok. Zawijanie
 * na sztywno też nie jest odpowiedzią — przy JSON-ie i tabelach łamanie linii gubi
 * strukturę, którą się właśnie ogląda. Stąd przełącznik, i to w samym bloku, a nie
 * gdzieś w ustawieniach strony.
 */
const WRAP_KEY = 'events-pl-panel:code-wrap';

/**
 * Preferencja jest WSPÓLNA dla wszystkich bloków i trwała. Kto raz włączył zawijanie,
 * ten chce je mieć też w następnym promptcie i po odświeżeniu — a nie klikać w każdym
 * bloku z osobna.
 */
const wrap = signal(localStorage.getItem(WRAP_KEY) === '1');

@Component({
  selector: 'app-code-view',
  imports: [TuiButton],
  templateUrl: './code-view.html',
  styleUrl: './code-view.less',
})
export class CodeView {
  readonly text = input.required<string>();
  readonly lang = input<CodeLang>('text');
  /** Nagłówek bloku — czym to jest (np. „response · JSON"). Pusty = sam pasek narzędzi. */
  readonly label = input('');
  readonly maxHeight = input('28rem');

  protected readonly wrap = wrap;
  protected readonly copied = signal(false);

  private readonly all = computed<CodeLine[]>(() => toLines(this.text(), this.lang()));

  protected readonly lines = computed(() => this.all().slice(0, LINE_CAP));
  protected readonly dropped = computed(() => Math.max(0, this.all().length - LINE_CAP));
  protected readonly stat = computed(
    () => `${this.all().length} linii · ${fmtBytes(this.text().length)}`,
  );

  protected toggleWrap(): void {
    wrap.update((v) => !v);
    localStorage.setItem(WRAP_KEY, wrap() ? '1' : '0');
  }

  protected copy(): void {
    navigator.clipboard.writeText(this.text()).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1200);
      },
      () => {
        /* schowek bywa zablokowany (kontekst bez https) — brak potwierdzenia wystarczy */
      },
    );
  }
}
