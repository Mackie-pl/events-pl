/**
 * PODZIAŁ PO AKAPITACH KONTRA PODZIAŁ PO DOM-IE, na żywych stronach.
 *
 * Osobne narzędzie od `measure-reuse`, i to nie z wygody: archiwum trzyma treść PO
 * html-to-text, a podział po DOM-ie potrzebuje HTML-a. Historii nie da się więc odtworzyć
 * i żaden przebieg wstecz nie odpowie, czy nowy podział jest lepszy. Zamiast tego pobieramy
 * stronę TERAZ, dzielimy ją oboma sposobami i pytamy o każdy blok: „czy ten tekst stał już
 * w ostatnim zrzucie z archiwum?".
 *
 * Test jest ten sam dla obu schematów, więc porównanie jest uczciwe, choć próbka to jedna
 * para dzień-do-dnia na źródło. Do tego właśnie służy: sprawdzić po zmianie w segmentacji,
 * czy poprawiła, czy popsuła — bo pierwsza wersja `dom-blocks.ts` renderowała karty osobno
 * i psuła o 56 punktów procentowych na stronach, które w ogóle się nie zmieniły. Bez tego
 * pomiaru wyglądałaby na działającą.
 *
 * UWAGA NA DZIEŃ BAZOWY. Gdy `daily` przeszedł dziś rano, najnowszy zrzut jest z DZIŚ i obie
 * kolumny pokażą blisko 100% — bo strona od rana się nie zmieniła. To wtedy test regresji
 * („czy nowy podział czegoś nie psuje"), a nie pomiar zysku. Żeby zobaczyć zysk, trzeba
 * bazy z wczoraj: `--base=<dzień>`.
 *
 *   npm run compare-segmentation
 *   npm run compare-segmentation -- --source=estrada
 *   npm run compare-segmentation -- --base=2026-08-06   # zysk względem wczoraj
 *   npm run compare-segmentation -- --days=30           # jak głęboko szukać zrzutu
 */
import { BROWSER_HEADERS, fetchUrl } from "../adapters/http.js";
import { toText } from "../adapters/page-fetch.js";
import { archiveEnabled } from "../adapters/supabase-archive.js";
import { type Block, segment } from "../pipeline/extract/blocks.js";
import { segmentHtml } from "../pipeline/extract/dom-blocks.js";
import { archivedDays, latestDump } from "../reporting/raw-dumps.js";
import { describeError } from "../shared/errors.js";
import { sourcesStore } from "../storage/index.js";

const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const lines = (s: string): string[] =>
  s.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Indeks pozycji wierszy w zrzucie bazowym. Bez niego sprawdzenie każdego bloku byłoby
 * przejściem po całym dokumencie, a bloków bywa siedemdziesiąt.
 */
function lineIndex(hay: string[]): Map<string, number[]> {
  const ix = new Map<string, number[]>();
  for (const [i, l] of hay.entries()) ix.set(l, [...(ix.get(l) ?? []), i]);
  return ix;
}

/**
 * Czy ciąg wierszy bloku stoi w zrzucie bazowym jako SPÓJNY fragment.
 *
 * Spójny, nie „wszystkie wiersze gdzieś tam są": ten drugi test zaliczyłby blok posklejany
 * z kawałków rozrzuconych po stronie, czyli dokładnie ten przypadek, który cache musi
 * odrzucić. Kryterium ma odpowiadać temu, co robi hash bloku.
 */
function seenIn(hay: string[], ix: Map<string, number[]>, block: string): boolean {
  const b = lines(block);
  if (!b.length) return true;
  for (const p of ix.get(b[0]!) ?? []) {
    if (p + b.length > hay.length) continue;
    let ok = true;
    for (let i = 1; i < b.length; i++) {
      if (hay[p + i] !== b[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

interface Score { blocks: number; freshBlocks: number; chars: number; reuse: number }

function score(blocks: Block[], hay: string[], ix: Map<string, number[]>): Score {
  let chars = 0, fresh = 0, freshBlocks = 0;
  for (const b of blocks) {
    chars += b.chars;
    if (!seenIn(hay, ix, b.text)) {
      fresh += b.chars;
      freshBlocks++;
    }
  }
  return { blocks: blocks.length, freshBlocks, chars, reuse: chars ? 1 - fresh / chars : 0 };
}

interface Row { id: string; base: string; para: Score; dom: Score; cards: number }

async function measure(
  id: string, url: string, days: string[],
): Promise<Row | { id: string; err: string }> {
  const prev = await latestDump(days, id, true);
  if (!prev) return { id, err: "brak zrzutu w archiwum" };
  let html: string;
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 30_000);
    if (!res.ok) return { id, err: `HTTP ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { id, err: describeError(e) };
  }
  const text = toText(html);
  if (!text.trim()) return { id, err: "pusta treść" };

  const hay = lines(prev.text);
  const ix = lineIndex(hay);
  const dom = segmentHtml(html);
  return {
    id, base: prev.day,
    para: score(segment(text), hay, ix),
    dom: score(dom.blocks, hay, ix),
    cards: dom.cards,
  };
}

function printRow(r: Row): void {
  const delta = (r.dom.reuse - r.para.reuse) * 100;
  console.log(
    r.id.slice(0, 23).padEnd(24) + r.base.padStart(12) +
    pct(r.para.reuse).padStart(10) + pct(r.dom.reuse).padStart(9) +
    String(r.cards).padStart(7) + `  ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`,
  );
}

/**
 * Dni, z których wolno wziąć zrzut bazowy — i ostrzeżenie, gdy baza jest z dziś.
 * Bez tego ostrzeżenia narzędzie po porannym cronie pokazuje „+1pp" i wygląda, jakby
 * nowy podział nic nie dawał, choć po prostu nie ma czego mierzyć.
 */
async function baseDays(): Promise<string[]> {
  const base = arg("base", "");
  const all = await archivedDays(Number(arg("days", "14")));
  const days = base ? all.filter((d) => d <= base) : all;
  if (!days.length) {
    console.log(base
      ? `Brak zrzutów z ${base} lub wcześniej — dostępne: ${all.join(", ") || "brak"}.`
      : "Archiwum puste — najpierw musi przejść choć jeden `npm run daily`.");
    return [];
  }
  if (days.at(-1) === new Date().toISOString().slice(0, 10)) {
    console.log(
      "UWAGA: baza jest z DZIŚ, więc obie kolumny pokażą prawie 100% — to test regresji,\n" +
      "nie pomiar zysku. Zysk widać dopiero względem wczoraj: --base=<wczorajszy dzień>.\n",
    );
  }
  return days;
}

async function main(): Promise<void> {
  if (!archiveEnabled()) {
    console.log("Archiwum wyłączone — bez SUPABASE_* nie ma zrzutu bazowego do porównania.");
    return;
  }
  const onlySource = arg("source", "");
  const days = await baseDays();
  if (!days.length) return;

  // tylko zwykły fetch: headless i Bright Data kosztują albo wymagają przeglądarki,
  // a pytanie dotyczy podziału treści, nie sposobu jej zdobycia
  const sources = (await sourcesStore.load()).sources.filter((s) => s.fetch === "plain");
  const wanted = sources.filter((s) => !onlySource || s.id === onlySource);
  console.log(`Baza: najnowszy zrzut do ${days.at(-1)} włącznie. ${wanted.length} źródeł.\n`);
  console.log(
    "źródło".padEnd(24) + "baza".padStart(12) + "akapity".padStart(10) +
    "DOM".padStart(9) + "kart".padStart(7) + "  Δ",
  );

  const rows: Row[] = [];
  for (const s of wanted) {
    const r = await measure(s.id, s.url.replace("{page}", "1"), days);
    if ("err" in r) {
      console.log(s.id.slice(0, 23).padEnd(24) + r.err.slice(0, 30).padStart(12));
      continue;
    }
    rows.push(r);
    printRow(r);
  }
  if (!rows.length) {
    console.log("\nNic nie udało się porównać.");
    return;
  }
  printTotals(rows);
}

/**
 * Podsumowanie z osobną listą POGORSZEŃ. Sama średnia potrafi wyjść na plus przy schemacie,
 * który psuje kilka źródeł na maksa — a to właśnie pogorszenia są sygnałem błędu, nie zysku.
 */
function printTotals(rows: Row[]): void {
  const chars = rows.reduce((a, r) => a + r.dom.chars, 0);
  const paraR = rows.reduce((a, r) => a + r.para.reuse * r.dom.chars, 0) / chars;
  const domR = rows.reduce((a, r) => a + r.dom.reuse * r.dom.chars, 0) / chars;
  const free = (f: (r: Row) => Score): number => rows.filter((r) => f(r).freshBlocks === 0).length;
  console.log(
    `\nRAZEM ${rows.length} źródeł, ${chars} znaków\n` +
    `  akapity : ${pct(paraR)}  (${free((r) => r.para)} źródeł bez nowego bloku)\n` +
    `  DOM     : ${pct(domR)}  (${free((r) => r.dom)} źródeł bez nowego bloku)\n` +
    `  różnica : ${((domR - paraR) * 100).toFixed(1)}pp`,
  );
  const worse = rows
    .filter((r) => r.dom.reuse < r.para.reuse - 0.01)
    .sort((a, b) => (a.dom.reuse - a.para.reuse) - (b.dom.reuse - b.para.reuse));
  if (worse.length) {
    console.log(
      `\nPOGORSZENIA (${worse.length}) — tu podział po DOM-ie gubi więcej niż po akapitach:\n  ` +
      worse.map((r) => `${r.id} ${((r.dom.reuse - r.para.reuse) * 100).toFixed(1)}pp`).join("\n  "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
