import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge, TuiChip } from '@taiga-ui/kit';

import { ArchiveService } from '../../archive';
import { DataService } from '../../data';
import { STATUS_META, fmtDateTime, fmtMs, fmtNum, fmtTokens, fmtUsd } from '../../format';
import type { AuditKind, AuditStep, EventItem, EventRef } from '../../types';

const PREVIEW_KEY = 'events-pl-panel:preview';

/**
 * Ikona i wydźwięk kroku śladu. Wydźwięk (nie kolor) — chodzi o „czy to była decyzja
 * kosztowna / oszczędna / stratna", a nie o ozdobę: po tym skanuje się timeline wzrokiem.
 */
const STEP_META: Record<AuditKind, { icon: string; tone: 'plain' | 'spend' | 'save' | 'loss' }> = {
  skip: { icon: '@tui.circle-slash', tone: 'plain' },
  fetch: { icon: '@tui.download', tone: 'plain' },
  'fetch.fallback': { icon: '@tui.refresh-cw', tone: 'spend' },
  content: { icon: '@tui.file-diff', tone: 'plain' },
  'cache.hit': { icon: '@tui.database', tone: 'save' },
  llm: { icon: '@tui.sparkles', tone: 'spend' },
  'event.dropped': { icon: '@tui.trash-2', tone: 'loss' },
  'followup.proposed': { icon: '@tui.list-plus', tone: 'plain' },
  followup: { icon: '@tui.corner-down-right', tone: 'plain' },
  'fb.harvest': { icon: '@tui.link', tone: 'plain' },
  geo: { icon: '@tui.map-pin', tone: 'plain' },
  'dedupe.dropped': { icon: '@tui.merge', tone: 'loss' },
  pii: { icon: '@tui.shield', tone: 'plain' },
  done: { icon: '@tui.flag', tone: 'plain' },
};

@Component({
  selector: 'app-source',
  imports: [RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiChip],
  templateUrl: './source.html',
  styleUrl: './source.less',
})
export class SourcePage {
  readonly runId = input.required<string>();
  readonly sourceId = input.required<string>();

  protected readonly data = inject(DataService);
  protected readonly archive = inject(ArchiveService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly ms = fmtMs;
  protected readonly usd = fmtUsd;
  protected readonly tok = fmtTokens;
  protected readonly dt = fmtDateTime;
  protected readonly num = fmtNum;
  protected readonly statusMeta = STATUS_META;

  protected readonly run = computed(() => this.data.runByStartedAt(this.runId()));

  protected readonly sourceRun = computed(() =>
    this.run()?.sources.find((s) => s.id === this.sourceId()),
  );

  /** Static registry entry from sources.json (type, verified, notes). */
  protected readonly sourceMeta = computed(() =>
    this.data.sources.value()?.sources.find((s) => s.id === this.sourceId()),
  );

  /**
   * What this source produced IN THIS RUN, before dedupe — recorded in runs.json, so it stays
   * true for historical runs. Older runs predate the field: fall back to filtering the latest
   * events.json, which is what this page used to do for every run.
   */
  protected readonly produced = computed<EventRef[]>(() => {
    const s = this.sourceRun();
    if (!s) return [];
    if (s.produced) return s.produced;
    return this.data.events
      .value()
      .events.filter((e) => e.source_id === this.sourceId())
      .map((e) => ({ title: e.title, date: e.date_start, url: e.source_url }));
  });

  /** True when the run itself carries event identity — otherwise we're guessing from today's file. */
  protected readonly hasProduced = computed(() => this.sourceRun()?.produced !== undefined);

  protected readonly mergedAway = computed(
    () => this.produced().filter((r) => r.mergedInto).length,
  );

  protected readonly isLatestRun = computed(() => this.data.isLatest(this.runId()));

  /** Full records by "title|date" — the only key shared between a ref and events.json. */
  private readonly fullByKey = computed(
    () => new Map(this.data.events.value().events.map((e) => [`${e.title}|${e.date_start}`, e])),
  );

  /**
   * Full record for a ref, when there is one. A ref that lost dedupe, or belongs to a run older
   * than the current events.json, has no counterpart — the archive holds those.
   */
  protected full(ref: EventRef): EventItem | undefined {
    return this.fullByKey().get(`${ref.title}|${ref.date}`);
  }

  /** Selected event; resets when the source changes. */
  protected readonly selected = linkedSignal<EventRef | null>(() => {
    // Depend on the event list so selection resets on navigation.
    this.produced();
    return null;
  });

  protected readonly showRawJson = signal(false);

  // --- ślad decyzyjny (audit.json) ---

  constructor() {
    // pobranie startuje dopiero stąd: audit.json jest duży, a potrzebny wyłącznie tutaj
    this.data.requestAudit();
  }

  protected readonly trail = computed(() => this.data.trailFor(this.runId(), this.sourceId()));

  protected readonly trailLoading = computed(() => this.data.audit.isLoading());

  protected readonly stepMeta = STEP_META;

  /** Detale jako pary do wyświetlenia — pomijamy puste, żeby nie robić szumu z null-i. */
  protected detailPairs(step: AuditStep): { k: string; v: string }[] {
    return Object.entries(step.detail ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ({ k, v: String(v) }));
  }

  /** Ścieżki w prywatnym archiwum; treść pobieralna tylko przez lokalny most. */
  protected readonly archivePaths = computed(() => this.sourceRun()?.archive ?? []);

  protected readonly openedPath = signal<string | null>(null);
  protected readonly archiveBody = signal<string | null>(null);
  protected readonly archiveLoading = signal(false);

  /** raw/…/<sha>.json → "raw · sha 124c64…"; llm/…/0001-model.json → "llm · 0001-model" */
  protected archiveLabel(path: string): string {
    const [kind = ''] = path.split('/');
    const file = path.split('/').pop() ?? path;
    const name = file.replace(/\.json$/, '');
    return kind === 'raw' ? `raw · ${name.slice(0, 12)}…` : `${kind} · ${name}`;
  }

  protected toggleArchive(path: string): void {
    if (this.openedPath() === path) {
      this.openedPath.set(null);
      this.archiveBody.set(null);
      return;
    }
    this.openedPath.set(path);
    this.archiveBody.set(null);
    this.archiveLoading.set(true);
    this.archive.object(path).subscribe((text) => {
      // ignoruj odpowiedź, jeśli w międzyczasie kliknięto inny obiekt
      if (this.openedPath() !== path) return;
      this.archiveBody.set(text);
      this.archiveLoading.set(false);
    });
  }

  protected readonly showPreview = signal(localStorage.getItem(PREVIEW_KEY) !== '0');

  protected readonly previewUrl = computed(
    () => this.selected()?.url ?? this.sourceRun()?.url ?? '',
  );

  protected readonly safePreviewUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.previewUrl();
    if (!url || !/^https?:\/\//.test(url)) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  protected select(ref: EventRef): void {
    this.selected.set(this.selected() === ref ? null : ref);
    this.showRawJson.set(false);
  }

  protected togglePreview(): void {
    this.showPreview.update((v) => !v);
    localStorage.setItem(PREVIEW_KEY, this.showPreview() ? '1' : '0');
  }

  protected json(event: EventItem): string {
    return JSON.stringify(event, null, 2);
  }

  protected price(e: EventItem): string {
    if (e.price.free === true) return 'free';
    if (e.price.amount_pln != null) return `${e.price.amount_pln} PLN`;
    return e.price.note ?? '—';
  }

  protected age(e: EventItem): string {
    if (!e.age) return '—';
    if (e.age.label) return e.age.label;
    if (e.age.min != null || e.age.max != null) return `${e.age.min ?? '?'}–${e.age.max ?? '?'}`;
    return '—';
  }
}
