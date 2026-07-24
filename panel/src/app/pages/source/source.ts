import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge, TuiChip } from '@taiga-ui/kit';

import { ArchiveService } from '../../archive';
import { DataService } from '../../data';
import { STATUS_META, fmtDateTime, fmtMs, fmtNum, fmtTokens, fmtUsd } from '../../format';
import type { EventItem } from '../../types';

const PREVIEW_KEY = 'events-pl-panel:preview';

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

  /** Events extracted from this source — always from the latest events.json. */
  protected readonly events = computed(() =>
    this.data.events.value().events.filter((e) => e.source_id === this.sourceId()),
  );

  protected readonly isLatestRun = computed(() => this.data.isLatest(this.runId()));

  /** Selected event; resets when the source changes. */
  protected readonly selected = linkedSignal<EventItem | null>(() => {
    // Depend on the event list so selection resets on navigation.
    this.events();
    return null;
  });

  protected readonly showRawJson = signal(false);

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
    () => this.selected()?.source_url ?? this.sourceRun()?.url ?? '',
  );

  protected readonly safePreviewUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.previewUrl();
    if (!url || !/^https?:\/\//.test(url)) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  protected select(event: EventItem): void {
    this.selected.set(this.selected() === event ? null : event);
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
