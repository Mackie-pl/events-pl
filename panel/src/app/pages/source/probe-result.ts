import { Component, computed, input, signal } from '@angular/core';
import { TuiButton, TuiIcon, TuiLink } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';

import { STATUS_META, STEP_META, fmtMs, fmtNum, fmtTokens, fmtUsd } from '../../format';
import type { AuditStep, EventItem, ProbeLlmCall, ProbeResult } from '../../types';

/**
 * Wynik sondy „sprawdź to źródło teraz" — świeży przebieg JEDNEGO źródła z lokalnego mostu.
 *
 * Osobny komponent od strony źródła, mimo podobnych sekcji, bo pokazuje coś innego: nie wpis
 * z runs.json sprzed godzin, tylko to, co dzieje się z tym adresem w tej chwili. Stąd dwie
 * rzeczy, których widok przebiegu mieć nie może i nie powinien:
 *
 *   - PROMPTY I ODPOWIEDZI MODELU wprost, bez chodzenia do archiwum,
 *   - wydarzenia PRZED scalaniem duplikatów i PRZED redakcją PII (dane zostają na localhoście).
 */
@Component({
  selector: 'app-probe-result',
  imports: [TuiButton, TuiIcon, TuiLink, TuiBadge],
  templateUrl: './probe-result.html',
  styleUrl: './probe-result.less',
})
export class ProbeResultView {
  readonly result = input.required<ProbeResult>();

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly num = fmtNum;
  protected readonly statusMeta = STATUS_META;
  protected readonly stepMeta = STEP_META;

  protected readonly run = computed(() => this.result().run);

  /** Rozwinięty wpis: wydarzenie po indeksie albo wywołanie modelu po indeksie (rozłącznie). */
  protected readonly openEvent = signal<number | null>(null);
  protected readonly openCall = signal<number | null>(null);

  protected toggleEvent(i: number): void {
    this.openEvent.update((v) => (v === i ? null : i));
  }

  protected toggleCall(i: number): void {
    this.openCall.update((v) => (v === i ? null : i));
  }

  /**
   * Jak na stronie źródła — ta sama umowa o kluczach. `archive` odpada bez przycisku:
   * sonda podmienia recorder na własny, więc jej wywołania nigdzie nie lądują, a prompty
   * i tak są niżej, w sekcji wywołań modelu.
   */
  protected detailPairs(step: AuditStep): { k: string; v: string }[] {
    return Object.entries(step.detail ?? {})
      .filter(([k, v]) => k !== 'archive' && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ({ k, v: k === 'usd' && typeof v === 'number' ? fmtUsd(v) : String(v) }));
  }

  protected json(e: EventItem): string {
    return JSON.stringify(e, null, 2);
  }

  /** „extract · haiku-4.5 · 12.3k → 840 tok · $0.0041 · 3.2 s" — rachunek jednego wywołania. */
  protected callLine(c: ProbeLlmCall): string {
    const model = c.model.split('/').pop() ?? c.model;
    return (
      `${c.task} · ${model} · ${fmtTokens(c.usage.promptTokens)} → ` +
      `${fmtTokens(c.usage.completionTokens)} tok · ${fmtUsd(c.usage.costUsd)} · ${fmtMs(c.ms)}`
    );
  }
}
