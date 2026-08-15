import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, type TuiDialogContext, tuiDialog } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { injectContext } from '@taiga-ui/polymorpheus';

import { BridgeService } from '../bridge';
import { fmtMs, fmtTokens, fmtUsd } from '../format';

import { asPrettyJson } from './code-lines';
import { CodeView } from './code-view';
import { type LlmCallView, llmCallFromJson } from './llm-call';

export interface LlmInspectorInput {
  /** Wywołanie już w pamięci (sonda). */
  call?: LlmCallView;
  /** Ścieżka w prywatnym archiwum — inspektor dociąga ją sam, przez lokalny most. */
  path?: string;
}

type Tab = 'prompt' | 'response' | 'system' | 'raw';

/**
 * Inspektor wywołania modelu: rachunek u góry, prompt i odpowiedź w zakładkach.
 *
 * Do tej pory jedyną drogą do promptu było wylanie całego obiektu archiwum do `<pre>` —
 * czyli jedna linia na kilkadziesiąt tysięcy znaków, z odpowiedzią modelu zaescapowaną
 * w środku jako `\"title\": \"…\"`. Formalnie wszystko tam było; przeczytać się tego nie
 * dało. Tutaj prompt jest rozbity na linie, a odpowiedź WYPARSOWANA z powrotem do JSON-a
 * i pokolorowana, bo to ona jest przedmiotem każdego pytania „czemu model tak zrobił".
 */
@Component({
  selector: 'app-llm-inspector',
  imports: [TuiButton, TuiBadge, CodeView],
  templateUrl: './llm-inspector.html',
  styleUrl: './llm-inspector.less',
})
export class LlmInspector {
  readonly context = injectContext<TuiDialogContext<void, LlmInspectorInput>>();

  private readonly bridge = inject(BridgeService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;

  protected readonly call = signal<LlmCallView | null>(null);
  protected readonly loading = signal(false);
  /** Treść, która nie okazała się wywołaniem modelu — pokazujemy ją surowo zamiast błędu. */
  protected readonly fallback = signal<string | null>(null);

  protected readonly tab = signal<Tab>('prompt');

  /** Odpowiedź z powrotem jako JSON — wraz z adnotacją, gdy się nie dała sparsować. */
  protected readonly response = computed(() => asPrettyJson(this.call()?.response ?? ''));

  protected readonly tabs = computed<Tab[]>(() => {
    const c = this.call();
    if (!c) return [];
    return c.system ? ['prompt', 'response', 'system', 'raw'] : ['prompt', 'response', 'raw'];
  });

  constructor() {
    const { call, path } = this.context.data;
    if (call) {
      this.call.set(call);
      return;
    }
    if (!path) return;
    this.loading.set(true);
    this.bridge.object(path).subscribe((text) => {
      this.loading.set(false);
      const parsed = llmCallFromJson(text, path);
      if (parsed) this.call.set(parsed);
      else this.fallback.set(text);
    });
  }

  protected readonly title = computed(() => {
    const c = this.call();
    if (!c) return this.context.data.path ?? '';
    const model = c.model.split('/').pop() ?? c.model;
    return c.task ? `${c.task} · ${model}` : model;
  });
}

/**
 * Otwieracz inspektora do wstrzyknięcia w polu komponentu:
 *
 *   protected readonly inspect = llmInspector();
 *   …
 *   (click)="inspect({ path })"
 *
 * `appearance: 'taiga wide'` zostawia wygląd Taigi i dokłada klasę, którą styles.less
 * poszerza okno — domyślne 50 rem to za mało na prompt z tabelą godzin.
 */
export function llmInspector(): (input: LlmInspectorInput) => void {
  const open = tuiDialog(LlmInspector, {
    size: 'l',
    appearance: 'taiga wide',
    label: 'Model call',
  });
  return (input) => {
    open(input).subscribe();
  };
}
