import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import {
  ALL_DECISIONS,
  ALL_OUTCOMES,
  DECISION_META,
  OUTCOME_META,
  fmtDateTime,
  fmtMs,
  fmtNum,
  fmtProbe,
  fmtTokens,
  fmtUsd,
} from '../../format';
import type { ProposalDecision, VerificationOutcome } from '../../types';

/**
 * Jeden przebieg discover od środka: co poszło do wyszukiwarki, co wróciło, co model
 * z tego zaproponował i co z każdą propozycją zrobiliśmy — łącznie z odrzuceniami,
 * bo „model tego nie zaproponował" i „odrzuciliśmy" wymagają różnych napraw.
 */
@Component({
  selector: 'app-discover-run',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './discover-run.html',
  styleUrl: './discover-run.less',
})
export class DiscoverRunPage {
  readonly runId = input.required<string>();

  protected readonly data = inject(DataService);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly probe = fmtProbe;
  protected readonly decisionMeta = DECISION_META;
  protected readonly decisions = ALL_DECISIONS;
  protected readonly outcomeMeta = OUTCOME_META;
  protected readonly outcomes = ALL_OUTCOMES;

  protected readonly run = computed(() => this.data.discoverRunByStartedAt(this.runId()));

  protected readonly expandedTown = signal<string | null>(null);
  protected readonly decisionFilter = signal<ProposalDecision | 'all'>('all');
  protected readonly outcomeFilter = signal<VerificationOutcome | 'all'>('all');

  /** Propozycje ze wszystkich gmin, spłaszczone — w jednym przebiegu jest ich kilkadziesiąt. */
  private readonly allProposals = computed(() =>
    (this.run()?.towns ?? []).flatMap((t) => (t.proposals ?? []).map((p) => ({ town: t.town, p }))),
  );

  protected readonly proposals = computed(() => {
    const f = this.decisionFilter();
    return this.allProposals().filter((x) => f === 'all' || x.p.decision === f);
  });

  protected readonly verifications = computed(() => {
    const f = this.outcomeFilter();
    return (this.run()?.verifications ?? []).filter((v) => f === 'all' || v.outcome === f);
  });

  protected proposalCount(d: ProposalDecision | 'all'): number {
    const all = this.allProposals();
    return d === 'all' ? all.length : all.filter((x) => x.p.decision === d).length;
  }

  protected verificationCount(o: VerificationOutcome | 'all'): number {
    const all = this.run()?.verifications ?? [];
    return o === 'all' ? all.length : all.filter((v) => v.outcome === o).length;
  }

  protected toggleTown(town: string): void {
    this.expandedTown.update((cur) => (cur === town ? null : town));
  }

  /** Ile wyników przyniosły zapytania tej gminy (po przycięciu historii: ile ich było). */
  protected resultCount(searches: { results: unknown[]; trimmed?: number }[]): number {
    return searches.reduce((n, s) => n + (s.results.length || (s.trimmed ?? 0)), 0);
  }

  /** Wysłane zapytania — pominięte (wyczerpany budżet / wyłączona wyszukiwarka) nie zużyły limitu. */
  protected sentCount(searches: { skipped?: boolean }[]): number {
    return searches.filter((s) => !s.skipped).length;
  }
}
