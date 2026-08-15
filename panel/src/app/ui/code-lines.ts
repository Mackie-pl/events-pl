/**
 * Podział tekstu na ponumerowane linie i (dla JSON-a) na tokeny do pokolorowania.
 *
 * Bez edytora w bundlu. Monaco to ~5 MB do statycznej strony, która ma OGLĄDAĆ prompt
 * i odpowiedź — nie edytować ich, nie podpowiadać typów i nie szukać po symbolach.
 * Kolorowanie JSON-a mieści się w jednym wyrażeniu regularnym, a cała reszta edytora
 * byłaby zapłacona czasem ładowania panelu, którego nikt tu nie chce.
 *
 * Tokenizacja idzie LINIA PO LINII i dlatego wolno jej być tak prosta: JSON.stringify
 * escapuje znaki nowej linii wewnątrz stringów (`\n`), więc żaden literał nie przechodzi
 * przez granicę linii i skanowanie nie musi pamiętać stanu.
 */

export type CodeLang = 'json' | 'text';

export type TokenKind = 'key' | 'str' | 'num' | 'lit' | 'punct' | 'text';

export interface Token {
  kind: TokenKind;
  text: string;
}

export interface CodeLine {
  n: number;
  tokens: Token[];
}

/** Powyżej tego rozmiaru rezygnujemy z kolorowania — czytelność nie jest warta zwiechy. */
const HIGHLIGHT_LIMIT = 400_000;

/** Powyżej tylu linii renderujemy początek: 100k wierszy DOM-u zabija zakładkę. */
export const LINE_CAP = 6000;

const JSON_TOKEN =
  /"(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

function kindOf(token: string): TokenKind {
  // klucz to string, który złapał ze sobą dwukropek — po nim nie kończy się cudzysłowem
  if (token.startsWith('"')) return token.endsWith('"') ? 'str' : 'key';
  if (token === 'true' || token === 'false' || token === 'null') return 'lit';
  return 'num';
}

function jsonTokens(line: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of line.matchAll(JSON_TOKEN)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'punct', text: line.slice(last, at) });
    out.push({ kind: kindOf(m[0]), text: m[0] });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ kind: 'punct', text: line.slice(last) });
  return out;
}

export function toLines(text: string, lang: CodeLang): CodeLine[] {
  const color = lang === 'json' && text.length <= HIGHLIGHT_LIMIT;
  return text.split('\n').map((line, i) => ({
    n: i + 1,
    tokens: color ? jsonTokens(line) : [{ kind: 'text' as const, text: line }],
  }));
}

/** „12.4 kB" — rozmiar tego, co się właśnie ogląda, żeby wiedzieć, czy warto kopiować. */
export function fmtBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} kB`;
  return `${(chars / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Odpowiedź modelu jako JSON, jeśli się da. Model bywa owija ją w ```json … ```,
 * a przy ucięciu na limicie tokenów oddaje kawałek, którego `JSON.parse` nie przyjmie —
 * i wtedy właśnie chce się ją zobaczyć, więc surowy tekst leci dalej z adnotacją.
 */
export function asPrettyJson(raw: string): { text: string; lang: CodeLang; note: string } {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { text: JSON.stringify(JSON.parse(body) as unknown, null, 2), lang: 'json', note: '' };
  } catch {
    const looksJson = body.startsWith('{') || body.startsWith('[');
    return {
      text: raw,
      lang: looksJson ? 'json' : 'text',
      note: looksJson ? 'nie parsuje się jako JSON (ucięta odpowiedź?) — surowy tekst' : '',
    };
  }
}
