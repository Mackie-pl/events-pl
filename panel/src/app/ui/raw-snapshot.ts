/**
 * Zrzut wejścia potoku — obiekt z prywatnego archiwum (`raw/…json`) sprowadzony do kształtu,
 * który umie pokazać podgląd. Mirrors archiveRaw() w src/adapters/supabase-archive.ts.
 *
 * Osobno od komponentu z tego samego powodu, co llm-call.ts od inspektora wywołań: parsowanie
 * cudzego JSON-a to nie jest widok. Obiekt przychodzi z mostu, więc traktujemy go jak świat
 * zewnętrzny — bez pola `text` to nie jest zrzut, a metadanych może brakować.
 */

import { type CodeLang, asPrettyJson } from './code-lines';

/** Jeden rekord dostawcy z migawki (post grupy, wydarzenie FB) — gdy treść jest listą. */
export interface RawRecord {
  i: number;
  /** pierwsza linia do rozpoznania rekordu bez rozwijania */
  head: string;
  chars: number;
  json: string;
}

export interface RawSnapshotView {
  url: string;
  /** czym to jest wg potoku: `html`, `pdf`, `fb_group`, `fb`, `fb_event`… */
  kind: string;
  runId: string;
  sourceId: string;
  fetchedAt: string;
  chars: number;
  /** treść zrzutu gotowa do czytania: JSON wypisany z wcięciami albo tekst jak leży */
  body: { text: string; lang: CodeLang; note: string };
  /** rekordy dostawcy; pusta lista = treść nie jest listą obiektów (zwykła strona) */
  records: RawRecord[];
  path?: string;
  /** surowy obiekt, tak jak leży w archiwum — zakładka „raw" */
  raw: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Jedna linia, po której poznaje się rekord: jego najdłuższy tekst, czyli zwykle treść postu.
 *
 * Adresy odpadają z wyścigu o najdłuższy napis, choć czasem wygrywają go z nawiązką: link do
 * zdjęcia w CDN-ie Facebooka ma ~400 znaków podpisu i wyglądał w wierszu jak treść rekordu,
 * której nie ma. Gdy w rekordzie nie ma nic poza adresami, pokazujemy adres — bo lepszy niż nic.
 */
function headOf(rec: unknown): string {
  const values = typeof rec === 'object' && rec !== null ? Object.values(rec) : [];
  const texts = values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  const longest = (list: string[]): string =>
    list.reduce((a, b) => (b.length > a.length ? b : a), '');
  const head = longest(texts.filter((t) => !/^https?:\/\//u.test(t.trim()))) || longest(texts);
  return (head || JSON.stringify(rec)).replace(/\s+/gu, ' ').trim().slice(0, 160);
}

/**
 * Rekordy z treści zrzutu. Kryterium jest KSZTAŁT, nie źródło: lista obiektów to migawka
 * dostawcy i chce się ją oglądać rekord po rekordzie, cokolwiek ją wyprodukowało. Zwykła
 * strona (tekst po html-to-text) zostaje bez rekordów i idzie w całości do zakładki treści.
 */
function recordsOf(text: string): RawRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const objs = parsed.filter((r) => typeof r === 'object' && r !== null);
  if (objs.length !== parsed.length || objs.length === 0) return [];
  return objs.map((rec, i) => {
    const json = JSON.stringify(rec, null, 2);
    return { i, head: headOf(rec), chars: json.length, json };
  });
}

/**
 * Obiekt archiwum → widok. `null`, gdy to nie jest zrzut — wywołujący pokazuje wtedy surowy
 * tekst zamiast błędu, dokładnie jak inspektor wywołań modelu.
 */
export function rawSnapshotFromJson(text: string, path?: string): RawSnapshotView | null {
  let parsed: {
    text?: unknown;
    url?: unknown;
    kind?: unknown;
    runId?: unknown;
    sourceId?: unknown;
    fetchedAt?: unknown;
    chars?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.text !== 'string') return null;
  const body = parsed.text;
  return {
    url: str(parsed.url),
    kind: str(parsed.kind),
    runId: str(parsed.runId),
    sourceId: str(parsed.sourceId),
    fetchedAt: str(parsed.fetchedAt),
    chars: typeof parsed.chars === 'number' ? parsed.chars : body.length,
    body: asPrettyJson(body),
    records: recordsOf(body),
    ...(path ? { path } : {}),
    raw: text,
  };
}

/** Czy ścieżka archiwum prowadzi do rozliczenia podziału — decyduje, który podgląd otworzyć. */
export function isBlocksPath(path: string): boolean {
  return path.startsWith('blocks/');
}
