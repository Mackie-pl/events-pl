import type {
  AuditKind,
  CostCategory,
  FetchProbe,
  ProposalDecision,
  SourceStatus,
  VerificationOutcome,
} from './types';

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0';
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`;
}

/** Jak fmtUsd, ale bez zer na końcu — oś ma nieść okrągłe liczby ($0.5), nie „$0.500". */
export function fmtUsdTick(v: number): string {
  if (v === 0) return '$0';
  return `$${Number(v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2))}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-GB');
}

export interface StatusMeta {
  label: string;
  appearance: string;
  icon: string;
}

export const STATUS_META: Record<SourceStatus, StatusMeta> = {
  ok: { label: 'ok', appearance: 'positive', icon: '@tui.check' },
  unchanged: { label: 'unchanged', appearance: 'neutral', icon: '@tui.minus' },
  error: { label: 'error', appearance: 'negative', icon: '@tui.triangle-alert' },
  'skipped-fb': { label: 'skipped fb', appearance: 'info', icon: '@tui.ban' },
  'skipped-dead': { label: 'skipped dead', appearance: 'negative', icon: '@tui.skull' },
  'skipped-inactive': { label: 'skipped inactive', appearance: 'warning', icon: '@tui.moon' },
  'skipped-blocked': { label: 'skipped blocked', appearance: 'negative', icon: '@tui.lock' },
  'skipped-costly': { label: 'skipped costly', appearance: 'warning', icon: '@tui.banknote' },
  empty: { label: 'empty', appearance: 'warning', icon: '@tui.circle-dashed' },
};

export const ALL_STATUSES: readonly SourceStatus[] = [
  'ok',
  'unchanged',
  'error',
  'skipped-fb',
  'skipped-dead',
  'skipped-inactive',
  'skipped-blocked',
  'skipped-costly',
  'empty',
];

// ---------------- ślad decyzyjny ----------------

/**
 * Ikona i wydźwięk kroku śladu. Wydźwięk (nie kolor) — chodzi o „czy to była decyzja
 * kosztowna / oszczędna / stratna", a nie o ozdobę: po tym skanuje się timeline wzrokiem.
 *
 * W format.ts, a nie przy stronie źródła, bo ten sam słownik renderuje dwa ślady: przebiegu
 * z audit.json i sondy na żądanie. Kopia oznaczałaby dwa różne wyglądy tego samego kroku.
 */
export const STEP_META: Record<
  AuditKind,
  { icon: string; tone: 'plain' | 'spend' | 'save' | 'loss' }
> = {
  skip: { icon: '@tui.circle-slash', tone: 'plain' },
  fetch: { icon: '@tui.download', tone: 'plain' },
  'fetch.fallback': { icon: '@tui.refresh-cw', tone: 'spend' },
  content: { icon: '@tui.file-diff', tone: 'plain' },
  'cache.hit': { icon: '@tui.database', tone: 'save' },
  capability: { icon: '@tui.plug', tone: 'save' },
  'capability.parsed': { icon: '@tui.braces', tone: 'save' },
  'capability.fallback': { icon: '@tui.corner-left-down', tone: 'spend' },
  llm: { icon: '@tui.sparkles', tone: 'spend' },
  'event.dropped': { icon: '@tui.trash-2', tone: 'loss' },
  // 'save': krok mówi, ILE bloków nie poszło do modelu — to jest oszczędność, nie zdarzenie
  block: { icon: '@tui.layers', tone: 'save' },
  // minione wydarzenie to nie strata: ono się odbyło, a serwis pokazuje przyszłość
  'event.past': { icon: '@tui.calendar-off', tone: 'plain' },
  'followup.proposed': { icon: '@tui.list-plus', tone: 'plain' },
  followup: { icon: '@tui.corner-down-right', tone: 'plain' },
  'fb.harvest': { icon: '@tui.link', tone: 'plain' },
  // 'spend': krok mówi, ile PŁATNYCH rekordów poszło na tę grupę i ile z nich było postami
  'fb.group': { icon: '@tui.activity', tone: 'spend' },
  // 'save': ten krok albo wycisza kosztowne źródło, albo pokazuje, że kanał zarabia na siebie
  'fb.value': { icon: '@tui.scale', tone: 'save' },
  geo: { icon: '@tui.map-pin', tone: 'plain' },
  'geo.not-found': { icon: '@tui.map-pin', tone: 'loss' },
  'dedupe.dropped': { icon: '@tui.merge', tone: 'loss' },
  // 'save', nie 'loss': zwinięcie serii nic nie usuwa z serwisu, tylko przestaje płacić
  // tokenami i wierszami digestu za dwudziestokrotne powtórzenie tego samego wpisu
  series: { icon: '@tui.repeat', tone: 'save' },
  pii: { icon: '@tui.shield', tone: 'plain' },
  done: { icon: '@tui.flag', tone: 'plain' },
};

// ---------------- discovery (stage 1) ----------------

/** Co model zaproponował i co się z tym stało. Odrzucenia są tu równie ważne jak dodania. */
export const DECISION_META: Record<ProposalDecision, StatusMeta> = {
  added: { label: 'added', appearance: 'positive', icon: '@tui.plus' },
  confirmed: { label: 'confirmed', appearance: 'success', icon: '@tui.link' },
  duplicate: { label: 'duplicate', appearance: 'neutral', icon: '@tui.copy' },
  'low-confidence': { label: 'low confidence', appearance: 'warning', icon: '@tui.gauge' },
  invalid: { label: 'invalid', appearance: 'negative', icon: '@tui.ban' },
};

export const ALL_DECISIONS: readonly ProposalDecision[] = [
  'added',
  'confirmed',
  'duplicate',
  'low-confidence',
  'invalid',
];

export const OUTCOME_META: Record<VerificationOutcome, StatusMeta> = {
  ok: { label: 'ok', appearance: 'positive', icon: '@tui.check' },
  fixed: { label: 'fixed', appearance: 'info', icon: '@tui.wrench' },
  dead: { label: 'dead', appearance: 'negative', icon: '@tui.skull' },
  error: { label: 'error', appearance: 'warning', icon: '@tui.triangle-alert' },
  skipped: { label: 'skipped', appearance: 'neutral', icon: '@tui.ban' },
};

export const ALL_OUTCOMES: readonly VerificationOutcome[] = [
  'ok',
  'fixed',
  'dead',
  'error',
  'skipped',
];

// ---------------- koszty ----------------

export interface CategoryMeta {
  label: string;
  /** co dokładnie kupujemy w tej kategorii — bez tego „scrape $0" nic nie znaczy */
  what: string;
  /** slot palety kategorialnej (1–6); kolor bierze się z CSS `--series-N` */
  slot: number;
}

/**
 * Kolejność jest **stała** i wyznacza kolor: slot 1 zawsze blue, slot 2 orange itd.
 * Gdyby kolor szedł za rankingiem, filtr zmieniający liczbę kategorii przemalowywałby
 * te, które zostały — i „ta pomarańczowa pozycja urosła" przestałoby cokolwiek znaczyć.
 * Darmowe pozycje (search/scrape/geo/storage) dzielą jeden slot: rysujemy je razem jako
 * „infra", a rozbicie zostaje w tabeli — inaczej sześć zerowych serii zaśmieca legendę.
 */
export const CATEGORY_META: Record<CostCategory, CategoryMeta> = {
  'llm-extract': { label: 'LLM · tekst', what: 'Haiku: treść stron i PDF-ów (etap 2)', slot: 1 },
  'llm-vision': {
    label: 'LLM · plakaty',
    what: 'Haiku multimodal: plakaty JPG/PNG (etap 2)',
    slot: 2,
  },
  'llm-discover': {
    label: 'LLM · discovery',
    what: 'Sonnet: triage kandydatów na źródła (etap 1)',
    slot: 3,
  },
  'llm-verify': { label: 'LLM · verify', what: 'Haiku: naprawa martwych URL-i (etap 1)', slot: 4 },
  fb: { label: 'Facebook', what: 'Bright Data: rekordy wydarzeń i postów grup', slot: 5 },
  search: {
    label: 'Search',
    what: 'wyszukiwarka: zapytania (Google CSE 100/dzień gratis)',
    slot: 6,
  },
  scrape: {
    label: 'Scraping',
    what: 'pobrania HTTP + headless (GH Actions: 0 zł dla repo publicznego)',
    slot: 6,
  },
  geo: {
    label: 'Geokodowanie',
    what: 'Nominatim: zapytania sieciowe (darmowe, limit 1/s)',
    slot: 6,
  },
  storage: {
    label: 'Archiwum',
    what: 'Supabase Storage: wysłane obiekty (darmowy tier ~1 GB)',
    slot: 6,
  },
};

/** Kategorie ze stawką zero — rysowane łącznie jako „infra", rozbite w tabeli. */
export const FREE_CATEGORIES: readonly CostCategory[] = ['search', 'scrape', 'geo', 'storage'];

/** Serie wykresu w stałej kolejności slotów palety. */
export const CHART_CATEGORIES: readonly CostCategory[] = [
  'llm-extract',
  'llm-vision',
  'llm-discover',
  'llm-verify',
  'fb',
];

export const ALL_CATEGORIES: readonly CostCategory[] = [...CHART_CATEGORIES, ...FREE_CATEGORIES];

/** „12 345 calls" — wolumen kategorii; MB z jednym miejscem po przecinku. */
export function fmtUnits(units: number, unit: string): string {
  const n = unit === 'MB' ? units.toFixed(1) : fmtNum(Math.round(units));
  return `${n} ${unit}`;
}

/** „HTTP 200 · text/html · 12 345 zn. · 340 ms" — jedna linia zamiast pięciu kolumn. */
export function fmtProbe(p: FetchProbe | undefined): string {
  if (!p) return '—';
  const parts = [
    p.httpStatus !== undefined ? `HTTP ${p.httpStatus}` : 'brak odpowiedzi',
    p.contentType,
    p.chars !== undefined ? `${fmtNum(p.chars)} chars` : undefined,
    fmtMs(p.ms),
  ].filter(Boolean);
  return parts.join(' · ');
}
