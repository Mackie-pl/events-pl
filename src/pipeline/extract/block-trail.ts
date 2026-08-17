/**
 * Widoczność podziału na bloki: co weszło, jak zostało pocięte, co z tego wyszło.
 *
 * Osobno od block-source.ts z tego samego powodu, co fb-group-trail.ts od ścieżki FB:
 * ścieżka ma podejmować decyzję, a nie opowiadać o niej. Tutaj mieszka całe opowiadanie.
 *
 * Podział był dotąd najciemniejszym miejscem potoku: ślad mówił „41 bloków, 39 z cache,
 * 2 do modelu" i na tym się kończył. Przy stronie, która kosztuje codziennie mimo braku
 * zmian, to za mało nawet na postawienie pytania — nie widać ANI który blok się rozjechał,
 * ANI czy strona w ogóle została rozpoznana jako lista. Stąd trzy poziomy szczegółu:
 *
 *   1. NOTKA kroku — liczby, które da się przeczytać wzrokiem w panelu (i w repo, bo
 *      audit.json jest publiczny).
 *   2. DETALE kroku — te same liczby maszynowo, plus adres i ścieżka do archiwum.
 *   3. ARCHIWUM (`blocks/…`) — wiersz na blok: hash, rozmiar, karta czy reszta strony,
 *      z cache czy do modelu, ile wydarzeń dał. Treść bloku TYLKO dla tych, za które
 *      dziś płacimy — reszta strony stoi już w `raw/`.
 *
 * Poziom 3 powstaje WYŁĄCZNIE w dniach ze świeżymi blokami. Dzień w pełni z cache'a nie ma
 * czego tłumaczyć: rozliczenie byłoby tabelą tych samych haszy co wczoraj, a płaciłoby za
 * miejsce raz na źródło na dobę — czyli najwięcej wtedy, gdy nie ma czego debugować.
 *
 * Poziom 3 jest prywatny (treść cudzych stron), więc poziomy 1–2 muszą się bronić same.
 */
import { archiveBlocks } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import type { PipelineState } from "../../types/index.js";

import type { Block } from "./blocks.js";
import type { DomSegmentation } from "./dom-blocks.js";

/** Ile znaków bloku wystarczy, żeby go rozpoznać w archiwum bez czytania całości. */
const HEAD_CHARS = 120;

/** Jak powstał podział — do notki i do archiwum, w jednym kształcie. */
export interface SplitInfo {
  /** „DOM, 38 kart" / „akapity (brak listy)" / „posty (12)" */
  how: string;
  url: string;
  /** znaki HTML-a na wejściu; brak dla PDF-ów, feedów i 304 */
  htmlChars?: number;
  /** rozliczenie DOM-u, gdy strona przez nie przeszła */
  dom?: DomSegmentation;
}

const pct = (part: number, whole: number): number =>
  whole ? Math.round((part / whole) * 100) : 0;

/**
 * 28431 → „28 431" — liczby w notce mają się czytać, a nie liczyć zer. Grupowanie własne,
 * bo `toLocaleString` wstawia spację NIEŁAMIĄCĄ, a notka jedzie do publicznego JSON-a,
 * gdzie taki znak wygląda na uszkodzone kodowanie.
 */
const num = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

const totalChars = (blocks: Block[]): number => blocks.reduce((n, b) => n + b.chars, 0);

/**
 * Krok „co poszło do modelu i dlaczego tyle" — emitowany PRZED wywołaniami, bo to decyzja,
 * a nie jej skutek. Znaki obok liczby bloków, bo płacimy za znaki: „2 z 41 bloków" brzmi
 * jak nic, a bywa połową strony, gdy tym jednym rozjechanym blokiem jest lista wydarzeń.
 */
export function auditSplit(info: SplitInfo, blocks: Block[], fresh: Block[]): void {
  const chars = totalChars(blocks);
  const freshChars = totalChars(fresh);
  const cached = blocks.length - fresh.length;
  audit("block",
    `podział: ${info.how} → ${blocks.length} bl. / ${num(chars)} zn.; `
    + `${cached} z cache, ${fresh.length} do modelu (${num(freshChars)} zn., `
    + `${pct(freshChars, chars)}% treści)`,
    {
      blocks: blocks.length, cached, fresh: fresh.length, chars, freshChars,
      how: info.how, url: info.url,
      ...(info.htmlChars !== undefined ? { htmlChars: info.htmlChars } : {}),
      ...(info.dom?.detected ? { cards: info.dom.cards, cardChars: info.dom.cardChars } : {}),
      ...(info.dom?.thinned ? { thinned: info.dom.thinned } : {}),
    });
}

/**
 * Krok „czemu nie po kartach" — tylko wtedy, gdy strona MIAŁA kandydatów na listę.
 *
 * Brak powtarzalnego rodzeństwa jest normą (strona jednego wydarzenia) i nie zasługuje na
 * wiersz. Odrzucenie grupy siedmiu `article.tile` na progu rozmiaru — zasługuje: to różnica
 * między „tu nie ma czego ciąć" a „tu jest lista, której nie umiemy przeciąć", a obie
 * wyglądały dotąd tak samo, czyli na nic.
 */
export function auditNearMiss(dom: DomSegmentation): void {
  if (dom.detected || dom.perturbed || !dom.nearMiss.length) return;
  const shown = dom.nearMiss.map((m) => `${m.sig} ×${m.n} (${m.why})`).join("; ");
  audit("block",
    `bez kart mimo ${dom.nearMiss.length} grup rodzeństwa — tniemy po akapitach. ${shown}`,
    { candidates: dom.nearMiss.length, why: shown });
}

/** Jeden wiersz rozliczenia — wyłącznie do prywatnego archiwum, nigdy do audit.json. */
interface Row {
  i: number;
  hash: string;
  chars: number;
  /** karta wydarzenia czy reszta strony (nagłówki, opisy, stopki treściowe) */
  card: boolean;
  state: "cached" | "fresh";
  /** dzień pierwszej ekstrakcji tego bloku — przy `cached` mówi, jak długo się trzyma */
  since?: string;
  events?: number;
  followups?: number;
  head: string;
  /** pełna treść TYLKO dla bloków, które dziś poszły do modelu */
  text?: string;
}

const head = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, HEAD_CHARS);

/**
 * Bloki, za które dziś zapłaciliśmy i nie wyszło z nich ani jedno wydarzenie — w ZNAKACH,
 * nie tylko w sztukach.
 *
 * Sama sztuka niczego nie waży: „18 z 19 bez ani jednego" brzmi jak katastrofa, a bywa
 * osiemnastoma jednolinijkowymi stopkami; odwrotnie, jeden jałowy blok potrafi być połową
 * strony. Płacimy za znaki, więc jałowość ma być mierzona tym, czym płacimy — inaczej nie
 * da się powiedzieć, ile z rachunku poszło na treść, z której nic nie wychodzi.
 *
 * `leads` odejmuje od tego bloki, które wprawdzie nie dały wydarzenia, ale wskazały podstronę
 * albo plakat. To nie jest strata, tylko wydatek, którego skutek widać dopiero w followupie —
 * a bez tego rozróżnienia strona-rozdzielacz (same linki do wydarzeń) wygląda w rachunku
 * jak najgorsze źródło w rejestrze.
 */
interface Waste {
  silent: number;
  silentChars: number;
  silentLeads: number;
}

function wasteOf(rows: Row[]): Waste {
  const mute = rows.filter((r) => r.state === "fresh" && !r.events);
  return {
    silent: mute.length,
    silentChars: mute.reduce((n, r) => n + r.chars, 0),
    silentLeads: mute.filter((r) => r.followups).length,
  };
}

/** Co trzeba wiedzieć o bloku poza nim samym — w jednym worku, bo `max-params` to 4. */
interface Ledger {
  cardHashes: Set<string>;
  freshHashes: Set<string>;
  state: PipelineState;
}

function row(b: Block, i: number, { cardHashes, freshHashes, state }: Ledger): Row {
  const entry = state.blocks?.[b.hash];
  const isFresh = freshHashes.has(b.hash);
  return {
    i, hash: b.hash.slice(0, 16), chars: b.chars, card: cardHashes.has(b.hash),
    state: isFresh ? "fresh" : "cached",
    ...(entry ? { since: entry.at, events: entry.events.length, followups: entry.followups.length } : {}),
    head: head(b.text),
    ...(isFresh ? { text: b.text } : {}),
  };
}

/**
 * Krok domykający: co bloki dały i gdzie leży pełne rozliczenie.
 *
 * Emitowany PO ekstrakcji, więc `state` zna już wynik świeżych bloków — dzięki temu jeden
 * przebieg po blokach opisuje naraz to, co przyszło z cache'a, i to, za co właśnie
 * zapłaciliśmy. Wcześniej te dwie liczby dawały się zestawić tylko przez odjęcie od siebie
 * dwóch kroków, i to bez podziału na konkretne bloki.
 */
export async function auditBlockResult(
  info: SplitInfo, blocks: Block[], fresh: Block[], state: PipelineState,
): Promise<void> {
  const ledger: Ledger = {
    cardHashes: new Set(info.dom?.cardHashes ?? []),
    freshHashes: new Set(fresh.map((b) => b.hash)),
    state,
  };
  const rows = blocks.map((b, i) => row(b, i, ledger));

  const sum = (kind: Row["state"], field: "events" | "followups"): number =>
    rows.filter((r) => r.state === kind).reduce((n, r) => n + (r[field] ?? 0), 0);
  const fromFresh = sum("fresh", "events");
  const fromCached = sum("cached", "events");
  const { silent, silentChars, silentLeads } = wasteOf(rows);
  const freshChars = totalChars(fresh);

  // ARCHIWUM TYLKO ZA ŚWIEŻE BLOKI. Dzień bez ani jednego to dzień, w którym rozliczenie
  // niesie same liczby — a te stoją już w notce kroku. Obiekt na źródło na dobę, w którym
  // nic się nie zmieniło, płaciłby za miejsce dokładnie wtedy, gdy nie ma czego debugować.
  const archive = fresh.length ? await archiveBlocks(info.url, {
    how: info.how,
    input: { htmlChars: info.htmlChars ?? null, textChars: totalChars(blocks) },
    dom: info.dom
      ? {
        detected: info.dom.detected, cards: info.dom.cards, cardChars: info.dom.cardChars,
        thinned: info.dom.thinned, perturbed: info.dom.perturbed ?? false,
        perturbedAt: info.dom.perturbedAt ?? null, nearMiss: info.dom.nearMiss,
      }
      : null,
    totals: { blocks: blocks.length, fresh: fresh.length, fromFresh, fromCached },
    blocks: rows,
  }) : null;

  // Znaki jałowych bloków stoją W NOTCE, nie tylko w detalach: notka jest jedyną warstwą,
  // którą da się przeczytać wzrokiem w surowym audit.json, a „ile z tej strony poszło na
  // darmo" to pytanie, dla którego ten krok w ogóle istnieje.
  audit("block.parsed",
    `${fresh.length} nowych bloków dało ${fromFresh} wydarzeń`
    + (silent
      ? ` (${silent} bez ani jednego: ${num(silentChars)} zn., `
        + `${pct(silentChars, freshChars)}% świeżej treści`
        + (silentLeads ? `, z tego ${silentLeads} wskazało followup` : "") + ")"
      : "")
    + `, ${blocks.length - fresh.length} z cache dało ${fromCached}`,
    {
      fromFresh, fromCached, silent, silentChars, silentLeads, freshChars,
      followups: sum("fresh", "followups") + sum("cached", "followups"),
      ...(archive ? { archive } : {}),
    });
}
