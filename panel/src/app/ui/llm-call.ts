import type { ProbeLlmCall } from '../types';

/**
 * Jedno wywołanie modelu w kształcie, który umie pokazać inspektor — niezależnie od tego,
 * skąd przyszło.
 *
 * Źródła są dwa i nigdy się nie spotkają: sonda oddaje wywołanie od razu w odpowiedzi HTTP
 * (`ProbeLlmCall`), a cronowy przebieg odkłada je do prywatnego archiwum (`llm/…json`,
 * patrz archiveLlmCall w src/adapters/supabase-archive.ts). Ten typ jest ich najmniejszym
 * wspólnym mianownikiem, żeby widok istniał raz.
 */
export interface LlmCallView {
  model: string;
  task?: string;
  system: string;
  /** Prompt użytkownika jako tekst; części obrazowe zastąpione linijką o rozmiarze. */
  user: string;
  response: string;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  ms?: number;
  ok?: boolean;
  err?: string;
  /** `stop` vs `length` — odróżnia „model skończył" od „ucięliśmy go na limicie". */
  finish?: string;
  runId?: string;
  sourceId?: string | null;
  /**
   * Adres obrazu, który poszedł do modelu. Bajtów nie ma ani w archiwum, ani w odpowiedzi
   * sondy (setki kilobajtów base64 na wywołanie), więc plakat pokazujemy Z ORYGINAŁU.
   * Podpis w CDN-ie Facebooka wygasa po kilku dniach — starsze wywołania pokażą sam adres.
   */
  imageSrc?: string;
  /** Ścieżka w archiwum, jeśli stamtąd pochodzi. */
  path?: string;
  /** Surowy obiekt, tak jak leży w archiwum — zakładka „raw". */
  raw: string;
}

interface ImagePart {
  type: 'image_url';
  omitted?: boolean;
  bytes?: number;
  image_url?: { url: string };
}

type UserPart = { type: 'text'; text: string } | ImagePart;

interface ArchivedCall {
  model?: unknown;
  task?: unknown;
  system?: unknown;
  user?: unknown;
  response?: unknown;
  usage?: LlmCallView['usage'];
  ms?: number;
  ok?: boolean;
  err?: string;
  finish?: string;
  runId?: string;
  sourceId?: string | null;
  imageSrc?: unknown;
}

function imageLine(p: ImagePart): string {
  const bytes = p.bytes ?? p.image_url?.url.length ?? 0;
  return `[obraz pominięty — ${Math.round(bytes / 1024)} kB base64]`;
}

/** Prompt bywa tablicą części (tekst + plakaty). Sklejamy do jednego tekstu do czytania. */
function flattenUser(user: unknown): string {
  if (typeof user === 'string') return user;
  if (!Array.isArray(user)) return '';
  return (user as UserPart[])
    .map((p) => (p.type === 'text' ? p.text : imageLine(p)))
    .join('\n\n');
}

/**
 * Obiekt z archiwum → widok. `null`, gdy to nie jest wywołanie modelu (np. ktoś kliknął
 * ścieżkę `raw/…`) albo gdy treść nie jest JSON-em — wtedy woła się o surowy podgląd,
 * a nie o inspektora.
 */
export function llmCallFromJson(text: string, path?: string): LlmCallView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as ArchivedCall;
  if (typeof rec.model !== 'string' || typeof rec.response !== 'string') return null;
  return {
    model: rec.model,
    task: typeof rec.task === 'string' ? rec.task : undefined,
    system: typeof rec.system === 'string' ? rec.system : '',
    user: flattenUser(rec.user),
    response: rec.response,
    usage: rec.usage,
    ms: rec.ms,
    ok: rec.ok,
    err: rec.err,
    finish: rec.finish,
    runId: rec.runId,
    sourceId: rec.sourceId,
    ...(typeof rec.imageSrc === 'string' ? { imageSrc: rec.imageSrc } : {}),
    path,
    raw: text,
  };
}

/** Wywołanie z sondy — już w pamięci, bez chodzenia do archiwum. */
export function llmCallFromProbe(call: ProbeLlmCall): LlmCallView {
  return {
    model: call.model,
    task: call.task,
    system: call.system,
    user: call.user,
    response: call.response,
    usage: call.usage,
    ms: call.ms,
    ok: call.ok,
    err: call.err,
    ...(call.imageSrc ? { imageSrc: call.imageSrc } : {}),
    raw: JSON.stringify(call, null, 2),
  };
}

/** Czy ścieżka archiwum prowadzi do wywołania modelu — decyduje, który przycisk pokazać. */
export function isLlmPath(path: string): boolean {
  return path.startsWith('llm/');
}
