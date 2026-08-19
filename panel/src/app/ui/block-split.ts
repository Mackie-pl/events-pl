/**
 * Rozliczenie podziału strony na bloki — obiekt z prywatnego archiwum (`blocks/…json`)
 * sprowadzony do kształtu, który umie pokazać podgląd. Mirrors src/pipeline/extract/block-trail.ts.
 *
 * Osobno od komponentu z tego samego powodu, co llm-call.ts od inspektora wywołań: parsowanie
 * cudzego JSON-a to nie jest widok. Obiekt przychodzi z mostu, więc traktujemy go jak świat
 * zewnętrzny — wiersz bez treści odpada, nieznany `cut` normalizujemy, brak `dom` jest
 * normalnym stanem (PDF, feed, posty FB), a nie awarią.
 */

/** Czemu blok skończył się w tym miejscu — patrz `BlockCut` w src/pipeline/extract/blocks.ts. */
export type BlockCut = 'card' | 'post' | 'content' | 'ceiling' | 'end';

const CUTS: readonly BlockCut[] = ['card', 'post', 'content', 'ceiling', 'end'];

/**
 * Etykiety powodów cięcia. Nie są tłumaczeniem nazwy pola, tylko odpowiedzią na pytanie
 * „czemu tu": `ceiling` jest jedynym powodem zależnym od POZYCJI w dokumencie, więc psuje
 * lokalność cache'a — i dlatego jako jedyny ma ton ostrzegawczy.
 */
export const CUT_META: Record<BlockCut, { label: string; hint: string; warn?: boolean }> = {
  card: { label: 'card', hint: 'krawędź karty z podziału po DOM-ie' },
  post: { label: 'post', hint: 'granica dana przez źródło (post grupy FB)' },
  content: { label: 'content', hint: 'granica z treści akapitu — odporna na przesunięcia' },
  ceiling: {
    label: 'ceiling',
    hint: 'twardy sufit 4000 zn. — jedyna granica zależna od pozycji, psuje lokalność',
    warn: true,
  },
  end: { label: 'end', hint: 'koniec ciętego kawałka — dalej zaczyna się karta' },
};

export interface SplitBlock {
  i: number;
  hash: string;
  chars: number;
  /** karta wydarzenia czy reszta strony (nagłówki, filtry, stopki treściowe) */
  card: boolean;
  /** brak = rozliczenie sprzed 2026-08-19, które powodu cięcia jeszcze nie zapisywało */
  cut: BlockCut | null;
  fresh: boolean;
  /** dzień pierwszej ekstrakcji — przy bloku z cache'a mówi, jak długo się trzyma */
  since?: string;
  events: number;
  followups: number;
  text: string;
  /** treść urwana do nagłówka — rozliczenie sprzed 2026-08-19 miało ją tylko dla świeżych */
  truncated?: boolean;
}

/** Grupa powtarzalnego rodzeństwa ODRZUCONA jako lista kart, wraz z powodem odrzucenia. */
export interface NearMiss {
  sig: string;
  n: number;
  why: string;
}

export interface SplitView {
  url: string;
  /** „DOM, 50 kart" / „akapity (brak listy)" / „posty (12)" */
  how: string;
  sourceId?: string;
  path?: string;
  htmlChars: number | null;
  textChars: number;
  cards: number;
  cardChars: number;
  detected: boolean;
  /** znaki zdjęte z kart jako powtórki (obrazki, powielone odnośniki) */
  thinned: number;
  /** podział po DOM-ie odrzucony własną samokontrolą — i w którym miejscu */
  perturbedAt: string | null;
  nearMiss: NearMiss[];
  blocks: SplitBlock[];
  /** surowy obiekt, tak jak leży w archiwum — zakładka „raw" */
  raw: string;
}

const num = (v: unknown, def = 0): number => (typeof v === 'number' && isFinite(v) ? v : def);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Nieznany powód zostaje NIEZNANY. Rozliczenia sprzed 2026-08-19 nie mają pola `cut`,
 * a domyślne „content" byłoby zgadywanką pokazaną jako fakt — czyli dokładnie tym, przed
 * czym ten podgląd ma chronić.
 */
const toCut = (v: unknown): BlockCut | null => CUTS.find((c) => c === v) ?? null;

interface RawRow {
  i?: unknown;
  hash?: unknown;
  chars?: unknown;
  card?: unknown;
  cut?: unknown;
  state?: unknown;
  since?: unknown;
  events?: unknown;
  followups?: unknown;
  text?: unknown;
  /** rozliczenia sprzed 2026-08-19: 120 znaków zamiast treści (patrz `toRow`) */
  head?: unknown;
}

/**
 * Rozliczenia sprzed 2026-08-19 mają pełną treść WYŁĄCZNIE dla bloków świeżych, a dla
 * reszty 120-znakowy `head`. Odrzucenie takich wierszy zrobiłoby z dziesięciu dni archiwum
 * pustą listę, więc bierzemy nagłówek i mówimy wprost, że to urwane — inaczej podgląd
 * pokazywałby cudzy chrom jako blok długi na jedno zdanie.
 *
 * Wiersz zupełnie bez tekstu odpada: pusty udawałby blok bez zawartości, czyli coś, czego
 * podział nie produkuje.
 */
function toRow(r: RawRow, i: number): SplitBlock | null {
  const full = str(r.text);
  const text = full || str(r.head);
  if (!text) return null;
  const since = str(r.since);
  return {
    i: num(r.i, i),
    hash: str(r.hash),
    chars: num(r.chars, text.length),
    card: r.card === true,
    cut: toCut(r.cut),
    fresh: r.state === 'fresh',
    ...(since ? { since } : {}),
    events: num(r.events),
    followups: num(r.followups),
    text,
    ...(full ? {} : { truncated: true }),
  };
}

interface RawDom {
  detected?: unknown;
  cards?: unknown;
  cardChars?: unknown;
  thinned?: unknown;
  perturbedAt?: unknown;
  nearMiss?: unknown;
}

const toNearMiss = (v: unknown): NearMiss[] =>
  (Array.isArray(v) ? v : [])
    .map((m: { sig?: unknown; n?: unknown; why?: unknown }) => ({
      sig: str(m.sig), n: num(m.n), why: str(m.why),
    }))
    .filter((m) => m.sig);

interface RawSplit {
  url?: unknown;
  how?: unknown;
  sourceId?: unknown;
  input?: { htmlChars?: unknown; textChars?: unknown };
  dom?: RawDom | null;
  blocks?: unknown;
}

/**
 * Obiekt archiwum → widok. `null`, gdy to nie jest rozliczenie podziału — wywołujący
 * pokazuje wtedy surowy tekst zamiast błędu, dokładnie jak inspektor wywołań modelu.
 */
export function splitFromJson(text: string, path?: string): SplitView | null {
  let parsed: RawSplit;
  try {
    parsed = JSON.parse(text) as RawSplit;
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed.blocks) ? parsed.blocks : null;
  if (!rows || !str(parsed.how)) return null;

  const sourceId = str(parsed.sourceId);
  return {
    url: str(parsed.url),
    how: str(parsed.how),
    ...(sourceId ? { sourceId } : {}),
    ...(path ? { path } : {}),
    htmlChars: typeof parsed.input?.htmlChars === 'number' ? parsed.input.htmlChars : null,
    textChars: num(parsed.input?.textChars),
    ...domPart(parsed.dom ?? null),
    blocks: (rows as RawRow[]).map(toRow).filter((b): b is SplitBlock => b !== null),
    raw: text,
  };
}

/** Rozliczenie DOM-u; brak jest normalnym stanem (PDF, feed, posty FB), nie awarią. */
function domPart(dom: RawDom | null): Pick<
  SplitView, 'cards' | 'cardChars' | 'detected' | 'thinned' | 'perturbedAt' | 'nearMiss'
> {
  return {
    cards: num(dom?.cards),
    cardChars: num(dom?.cardChars),
    detected: dom?.detected === true,
    thinned: num(dom?.thinned),
    perturbedAt: typeof dom?.perturbedAt === 'string' ? dom.perturbedAt : null,
    nearMiss: toNearMiss(dom?.nearMiss),
  };
}

export interface SplitTotals {
  blocks: number;
  chars: number;
  fresh: number;
  freshChars: number;
  /** świeże bloki, z których nie wyszło ani jedno wydarzenie */
  silent: number;
  silentChars: number;
  events: number;
  cards: number;
  cardChars: number;
}

/**
 * Sumy liczone Z WIERSZY, nie brane z pola `totals` obiektu.
 *
 * Podgląd ma pokazywać to, co widać w tabeli — gdyby liczby przyszły z osobnego pola,
 * odfiltrowanie wiersza bez treści (patrz `toRow`) rozjechałoby nagłówek z zawartością
 * i nie dałoby się powiedzieć, która liczba kłamie.
 */
export function totalsOf(blocks: SplitBlock[]): SplitTotals {
  const t: SplitTotals = {
    blocks: blocks.length, chars: 0, fresh: 0, freshChars: 0,
    silent: 0, silentChars: 0, events: 0, cards: 0, cardChars: 0,
  };
  for (const b of blocks) {
    t.chars += b.chars;
    t.events += b.events;
    if (b.card) {
      t.cards += 1;
      t.cardChars += b.chars;
    }
    if (!b.fresh) continue;
    t.fresh += 1;
    t.freshChars += b.chars;
    if (!b.events) {
      t.silent += 1;
      t.silentChars += b.chars;
    }
  }
  return t;
}
