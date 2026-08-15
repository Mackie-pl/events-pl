import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { BridgeService } from '../../bridge';
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
import type {
  EntryPoint,
  ProposalDecision,
  SearchResult,
  SourceProposal,
  SourceVerification,
  VerificationOutcome,
} from '../../types';
import { isLlmPath } from '../../ui/llm-call';
import { llmInspector } from '../../ui/llm-inspector';
import { urlKey } from '../../url';

/**
 * Jedno trafienie wyszukiwarki wraz z jego losem. `fate: null` to najciekawszy przypadek:
 * model widział ten wynik i go NIE zaproponował — czego bez tego zestawienia nie dało się
 * odróżnić od „wyszukiwarka tego nie zwróciła".
 */
interface TracedHit {
  title: string | null;
  url: string | null;
  desc: string | null;
  fate: SourceProposal | null;
  /** adres listy wydarzeń, do którego to trafienie ostatecznie doprowadziło */
  entrypoints: EntryPoint[];
}

interface TracedQuery {
  town: string;
  query: string;
  ms: number;
  err?: string;
  skipped?: boolean;
  trimmed?: number;
  hits: TracedHit[];
}

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
  protected readonly bridge = inject(BridgeService);

  /**
   * Ten sam inspektor, co na stronie źródła. Discovery odkłada do archiwum dokładnie te same
   * obiekty `llm/…`, więc lista ścieżek pod przebiegiem może być klikalna zamiast być
   * wypisem do ręcznego przepisania.
   */
  protected readonly inspect = llmInspector();

  protected readonly isLlm = isLlmPath;

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
  protected readonly expandedVerification = signal<string | null>(null);
  protected readonly decisionFilter = signal<ProposalDecision | 'all'>('all');
  protected readonly outcomeFilter = signal<VerificationOutcome | 'all'>('all');

  /** Propozycje ze wszystkich gmin, spłaszczone — w jednym przebiegu jest ich kilkadziesiąt. */
  private readonly allProposals = computed(() =>
    (this.run()?.towns ?? []).flatMap((t) => (t.proposals ?? []).map((p) => ({ town: t.town, p }))),
  );

  /**
   * Ślad: zapytanie → wynik wyszukiwarki → decyzja modelu → adres listy wydarzeń.
   *
   * Wszystkie trzy warstwy leżały w raporcie osobno i nic ich nie łączyło, więc „skąd wzięło
   * się to źródło" dawało się odtworzyć tylko ręcznie, porównując URL-e wzrokiem. Spinamy je
   * po `urlKey`, tak samo jak robi to `matchHit` w potoku — inna reguła zrywałaby ślad.
   */
  protected readonly trace = computed<TracedQuery[]>(() => {
    const r = this.run();
    if (!r) return [];

    const proposalByUrl = new Map<string, SourceProposal>();
    for (const t of r.towns) {
      for (const p of t.proposals ?? []) proposalByUrl.set(urlKey(p.url), p);
    }
    const entrypointsById = new Map<string, EntryPoint[]>(
      r.verifications.filter((v) => v.entrypoints?.length).map((v) => [v.id, v.entrypoints ?? []]),
    );

    const traceHit = (res: SearchResult): TracedHit => {
      const fate = res.url ? (proposalByUrl.get(urlKey(res.url)) ?? null) : null;
      return { ...res, fate, entrypoints: fate ? (entrypointsById.get(fate.id) ?? []) : [] };
    };

    return r.towns.flatMap((t) =>
      t.searches.map((s) => ({
        town: t.town,
        query: s.query,
        ms: s.ms,
        ...(s.err ? { err: s.err } : {}),
        ...(s.skipped ? { skipped: s.skipped } : {}),
        ...(s.trimmed ? { trimmed: s.trimmed } : {}),
        hits: s.results.map(traceHit),
      })),
    );
  });

  /** Czy w ogóle jest co pokazywać — przebiegi `verify` nie mają gmin, stare mają puste wyniki. */
  protected readonly hasTrace = computed(() => this.trace().some((q) => q.hits.length > 0));

  protected readonly removed = computed(() => this.run()?.reset?.removed ?? []);
  protected readonly notReturned = computed(() => this.removed().filter((x) => !x.returned));

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

  protected toggleVerification(id: string): void {
    this.expandedVerification.update((cur) => (cur === id ? null : id));
  }

  /** Czy jest co rozwijać — bez tego wiersze `skipped` dostawały pustą szufladę i chevron kłamał. */
  protected hasDetail(v: SourceVerification): boolean {
    return Boolean(
      v.ladder?.length ||
      v.entrypoints?.length ||
      v.capabilities?.length ||
      v.candidate ||
      v.archive?.length ||
      v.searches.length,
    );
  }

  /**
   * Czas poza samym pobraniem: profil modelu + sondowanie zdolności. Bez tego wiersz mówił
   * „3,4 s" w kolumnie odpowiedzi i „24,1 s" w kolumnie czasu, a różnica 20 s wyglądała
   * na błąd pomiaru zamiast na to, czym jest — na wywołanie LLM-a i pobrania wp-json/rss.
   */
  protected profileMs(v: SourceVerification): number {
    return Math.max(0, v.ms - (v.probe?.ms ?? 0));
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
