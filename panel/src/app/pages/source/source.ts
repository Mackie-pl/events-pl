import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge, TuiChip } from '@taiga-ui/kit';

import { BridgeService } from '../../bridge';
import { DataService } from '../../data';
import {
  STATUS_META, STEP_META, fmtDateTime, fmtMs, fmtNum, fmtTokens, fmtUsd,
} from '../../format';
import type { AuditStep, EventItem, EventRef, ProbeResult } from '../../types';

import { ProbeResultView } from './probe-result';

const PREVIEW_KEY = 'events-pl-panel:preview';

@Component({
  selector: 'app-source',
  imports: [
    RouterLink, TuiButton, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge, TuiChip,
    ProbeResultView,
  ],
  templateUrl: './source.html',
  styleUrl: './source.less',
})
export class SourcePage {
  readonly runId = input.required<string>();
  readonly sourceId = input.required<string>();

  protected readonly data = inject(DataService);
  protected readonly bridge = inject(BridgeService);
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

  /**
   * Koszt źródła w rozbiciu na dostawców.
   *
   * Kafelek „Cost" pokazywał dotąd wyłącznie `llm.costUsd`, a przy grupie FB to zwykle
   * MNIEJSZA połowa rachunku: `fb-group-imprezy-poznan` 2026-08-12 to $0.0502 modelu
   * i $0.0750 Bright Data. Pytanie „co tu właściwie kosztuje" nie dawało się z tej strony
   * postawić, a od niego zaczyna się każda decyzja o wyciszeniu grupy.
   *
   * Stawka idzie z costs.json — tej samej księgi, którą liczy potok, żeby panel nie miał
   * własnej kopii cennika i nie rozjeżdżał się z rachunkiem po cichu.
   */
  protected readonly cost = computed(() => {
    const s = this.sourceRun();
    if (!s) return null;
    const records = s.bd?.records ?? 0;
    const bd = records * this.data.costs.value().rates.bdPerRecord;
    return { llm: s.llm.costUsd, bd, records, total: s.llm.costUsd + bd, hasBd: s.bd !== undefined };
  });

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

  /**
   * Detale jako pary do wyświetlenia — pomijamy puste, żeby nie robić szumu z null-i.
   * `archive` wypada z par, bo ma własny przycisk: jako `archive=llm/2026-08-13/…` byłby
   * nieklikalnym śmieciem w linijce, która ma się skanować wzrokiem.
   */
  protected detailPairs(step: AuditStep): { k: string; v: string }[] {
    return Object.entries(step.detail ?? {})
      .filter(([k, v]) => k !== 'archive' && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ({ k, v: k === 'usd' && typeof v === 'number' ? fmtUsd(v) : String(v) }));
  }

  /** Ścieżka tego, co krok odłożył w archiwum; brak = archiwum było wyłączone. */
  protected stepArchive(step: AuditStep): string | null {
    const p = step.detail?.['archive'];
    return typeof p === 'string' && p ? p : null;
  }

  /**
   * Co się otworzy pod przyciskiem. Nazwa rzeczy, nie „Show" — przy kroku modelu to prompt
   * z odpowiedzią, przy podziale rozliczenie blok po bloku, przy Bright Data surowa migawka.
   */
  protected archiveButton(step: AuditStep): string {
    if (step.step === 'llm') return 'Prompt + response';
    return step.step === 'block.parsed' ? 'Blocks in / out' : 'Raw records';
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
    this.bridge.object(path).subscribe((text) => {
      // ignoruj odpowiedź, jeśli w międzyczasie kliknięto inny obiekt
      if (this.openedPath() !== path) return;
      this.archiveBody.set(text);
      this.archiveLoading.set(false);
    });
  }

  // --- sonda na żądanie (lokalny most) ---

  /** Wynik ostatniej sondy; kasowany przy zmianie źródła, żeby nie wisiał nad cudzą stroną. */
  protected readonly probe = linkedSignal<ProbeResult | null>(() => {
    this.sourceId();
    return null;
  });

  protected readonly probeError = linkedSignal<string | null>(() => {
    this.sourceId();
    return null;
  });

  protected readonly probing = signal(false);

  /**
   * `force` pomija cache: gwarantuje pobranie i wywołanie modelu, czyli KOSZTUJE.
   * Bez niego niezmieniona strona wraca z cache w ułamku sekundy i niczego nie sprawdza —
   * co jest tanie i bezużyteczne dokładnie wtedy, gdy chcesz zobaczyć, co model dziś zrobi.
   */
  protected runProbe(force: boolean): void {
    if (this.probing()) return;
    this.probing.set(true);
    this.probeError.set(null);
    const id = this.sourceId();
    this.bridge.probe(id, force).subscribe((r) => {
      // odpowiedź na źródło, z którego już wyszliśmy, nie ma gdzie się pokazać
      if (this.sourceId() !== id) return;
      this.probing.set(false);
      if ('error' in r) {
        this.probeError.set(r.error);
        return;
      }
      this.probe.set(r);
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
