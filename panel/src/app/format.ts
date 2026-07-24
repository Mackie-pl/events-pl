import type { SourceStatus } from './types';

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
  empty: { label: 'empty', appearance: 'warning', icon: '@tui.circle-dashed' },
};

export const ALL_STATUSES: readonly SourceStatus[] = [
  'ok',
  'unchanged',
  'error',
  'skipped-fb',
  'empty',
];
