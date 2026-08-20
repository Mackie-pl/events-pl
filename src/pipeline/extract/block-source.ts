/**
 * Ścieżka blokowa: do modelu idą wyłącznie te fragmenty strony, których jeszcze nie widzieliśmy.
 *
 * Trzecia droga obok maszynowej (capability-source.ts) i pełnostronicowej. Odmawia — zwraca
 * `null` — gdy strona nie ma z czego zrobić bloków albo gdy nieznanych bloków jest tyle,
 * że wyglądają na przebudowę serwisu; wtedy wywołujący leci starą drogą i nic nie traci.
 *
 * Wynik strony to SUMA po blokach, które dziś na niej stoją, i to jest cały mechanizm:
 * karta, która zniknęła z listy, po prostu nie wchodzi do sumy. Nie ma scalania, nie ma
 * odejmowania, nie ma czego pomylić — a przy podejściu „wyślij modelowi diff" właśnie
 * to scalanie byłoby jedynym miejscem, gdzie da się po cichu zepsuć events.json.
 */
import { type Fetched } from "../../adapters/page-fetch.js";
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { todayIso } from "../../shared/dates.js";
import type { BlockStats, EventItem, PipelineState } from "../../types/index.js";

import { type Block, segment, toBlock } from "./blocks.js";
import { detach, lookupBlock, storeBlock, touchBlock } from "./block-cache.js";
import { type SplitInfo, auditBlockResult, auditChrome, auditNearMiss, auditSplit } from "./block-trail.js";
import { looksLikeChrome } from "./chrome.js";
import { segmentHtml } from "./dom-blocks.js";
import { extractBatch } from "./extract.js";

/**
 * Sufit na liczbę NIEZNANYCH bloków, po którym wracamy na jedno wywołanie na całą stronę.
 *
 * Od czasu wywołań zbiorczych nie chroni już przed kosztem — paczka wszystkich bloków to
 * ta sama treść, co cała strona, więc zasiew źródła kosztuje mniej więcej tyle, co dawniej
 * jedno wywołanie (pomiar na `estrada`: 38 wywołań i $0.244 przy wywołaniach na blok,
 * 2 wywołania i $0.037 po zbiorczych). Zostaje jako hamulec na patologię: stronę losowaną
 * przy każdym pobraniu, która inaczej co dzień dosypywałaby setki martwych wpisów do cache'a.
 */
const MAX_BLOCK_CALLS = (): number => P.BLOCK_MAX_CALLS.get();
/** Poniżej tylu bloków podział nic nie wnosi — jedno wywołanie na całość jest tańsze. */
const MIN_BLOCKS = 2;
/** Sufit treści w jednej paczce — ten sam, co MAX_INPUT_CHARS przy wywołaniu na całą stronę. */
const BATCH_CHARS = 40_000;

/** Bloki strony: gotowe od źródła, po DOM-ie, gdy mamy HTML; inaczej po akapitach (PDF, feed, 304). */
function pageBlocks(fetched: Fetched, url: string): { blocks: Block[]; info: SplitInfo } {
  // podział DANY przez źródło bije każdy zgadywany — patrz Fetched.blocks
  if (fetched.blocks?.length) {
    return {
      blocks: fetched.blocks.map((text) => toBlock(text, "post")),
      info: { how: `posty (${fetched.blocks.length})`, url },
    };
  }
  if (fetched.kind !== "html" || !fetched.html) {
    return { blocks: segment(fetched.text), info: { how: "akapity", url } };
  }
  const seg = segmentHtml(fetched.html);
  const info: SplitInfo = { how: "", url, htmlChars: fetched.html.length, dom: seg };
  if (seg.perturbed) {
    // osobny krok śladu, bo to jedyny sygnał, że jakiś kształt HTML-a jest dla podziału
    // za trudny — a każdy taki przypadek dotąd okazywał się jednym konkretnym znacznikiem,
    // nie ogólną wadą metody. Bez `perturbedAt` zostałoby „czasem nie działa".
    audit("block", `podział po DOM-ie odrzucony samokontrolą — ${seg.perturbedAt ?? "brak szczegółu"}`,
      { perturbed: true, at: seg.perturbedAt ?? null });
    return { blocks: seg.blocks, info: { ...info, how: "akapity (DOM odrzucony samokontrolą)" } };
  }
  // grupy rodzeństwa odrzucone na progu rozmiaru — czemu ta strona NIE jest listą kart
  auditNearMiss(seg);
  const odchudzone = seg.thinned ? `, −${seg.thinned} zn. powtórek w kartach` : "";
  return {
    blocks: seg.blocks,
    info: {
      ...info,
      how: seg.detected ? `DOM, ${seg.cards} kart${odchudzone}` : `akapity (brak listy)${odchudzone}`,
    },
  };
}

/** Bloki nieznane cache'owi — dokładnie to, za co dziś zapłacimy. */
const freshOf = (blocks: Block[], state: PipelineState, today: string): Block[] =>
  blocks.filter((b) => lookupBlock(state, b.hash, today) === null);

/**
 * Paczki mieszczące się w limicie wejścia. Sufit jest ten sam, co przy wywołaniu na całą
 * stronę — paczka wszystkich bloków to przecież ta sama treść, tylko z nagłówkami.
 * Stąd zasiew nowego źródła kosztuje tyle, co dzisiejsze jedno wywołanie, a nie N razy tyle.
 */
export function chunk(blocks: Block[]): Block[][] {
  const out: Block[][] = [];
  let cur: Block[] = [];
  let size = 0;
  for (const b of blocks) {
    // + nagłówek „BLOK n:\n"; gdy pojedynczy blok przerasta limit, i tak musi jechać sam
    const cost = b.chars + 12;
    if (cur.length && size + cost > BATCH_CHARS) { out.push(cur); cur = []; size = 0; }
    cur.push(b);
    size += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Blok odsiany jako chrom — razem z powodem, bo bez niego odsiew jest niesprawdzalny. */
export interface SkippedChrome {
  block: Block;
  why: string;
}

/**
 * Rozdzielenie świeżych bloków na te, za które warto zapłacić, i CHROM.
 *
 * Chrom rozpoznaje `chrome.ts` — bez modelu, po słownictwie i kształcie, z bezwarunkowym
 * wetem na datę i godzinę. Odsiew nie zostawia po sobie ŻADNEGO stanu: nic nie wchodzi do
 * `state.blocks`, więc jutro ten sam fragment przejdzie tę samą (darmową) ocenę od nowa.
 * Strona, która zmieni kształt, zmienia werdykt sama — nie ma czego wygaszać ani odświeżać.
 *
 * FAIL CLOSED: gdy sito uzna za chrom CAŁĄ paczkę, nie odsiewamy niczego. Taka strona to albo
 * strona bez wydarzeń, albo pomyłka sita — i tylko drugie jest groźne. Koszt jednej strony
 * jest znany i mały, a cicho wygaszone źródło kosztuje wszystkie swoje wydarzenia naraz.
 */
export function partitionChrome(blocks: Block[]): { send: Block[]; skipped: SkippedChrome[] } {
  const send: Block[] = [];
  const skipped: SkippedChrome[] = [];
  for (const block of blocks) {
    const v = looksLikeChrome(block.text);
    if (v.chrome) skipped.push({ block, why: v.why });
    else send.push(block);
  }
  return send.length ? { send, skipped } : { send: blocks, skipped: [] };
}

/**
 * Suma po blokach obecnych dziś na stronie; wydarzenia NIEODSIANE z minionych.
 * Eksportowane dla testów — to tutaj mieszka reguła „znikający blok = znikające wydarzenia".
 */
export function unionOf(
  blocks: Block[], state: PipelineState, today: string,
): { events: EventItem[]; followups: string[]; context: Map<string, string> } {
  const events: EventItem[] = [];
  const followups: string[] = [];
  // followup → tekst bloku, w którym model go wskazał. Powstaje TU, bo to jedyne miejsce
  // znające jedno i drugie naraz: `state.blocks` trzyma odnośniki bez treści, a płaska lista
  // followupów przypisanie gubi. Plakat czytany bez tego zdania nie wie, którego roku dotyczy.
  const context = new Map<string, string>();
  for (const b of blocks) {
    touchBlock(state, b.hash, today);
    const entry = state.blocks?.[b.hash];
    if (!entry) continue;
    events.push(...detach(entry.events));
    for (const f of entry.followups) {
      if (!followups.includes(f)) followups.push(f);
      // pierwszy blok wygrywa: ten sam plakat podlinkowany dwa razy ma zwykle sensowny
      // opis przy pierwszym wystąpieniu, a drugie to „zobacz też"
      if (!context.has(f)) context.set(f, b.text);
    }
  }
  return { events, followups, context };
}

export interface BlockOutcome {
  events: EventItem[];
  followups: string[];
  /** followup → tekst bloku, przy którym stał; wejście do odczytu plakatu z kontekstem */
  context: Map<string, string>;
  note?: string;
  /** rozliczenie podziału — wywołujący wie, gdzie je zapisać (strona źródła czy followup) */
  blocks: BlockStats;
}

/**
 * `null` = ścieżka odmawia, wywołujący leci starą drogą.
 *
 * Wydarzenia wracają BEZ odsiewu minionych — odsiew robi wywołujący, na komplecie
 * (strona + followupy) i raz.
 *
 * Rozliczenie WRACA, zamiast wpisywać się w `SourceRun`: od czasu, gdy tą samą drogą chodzą
 * followupy (process-source.ts), jedno źródło woła tę funkcję wielokrotnie i zapis w miejscu
 * kazałby ostatniemu followupowi zamazać rozliczenie strony źródła.
 *
 * `program` dokłada się do wywołania TYLKO przy sondzie kontenerów (extract/container.ts):
 * strona programu opisuje zajęcia rytmem, a daty graniczne stoją na karcie, z której
 * przyszliśmy. Wynik ląduje w cache'u bloków normalnie — kontekst jest stały dla danej
 * podstrony, więc jutro te same bloki oddadzą te same terminy bez wywołania modelu.
 */
export async function blockSource(
  fetched: Fetched, url: string, state: PipelineState, program?: string,
): Promise<BlockOutcome | null> {
  const { blocks, info } = pageBlocks(fetched, url);
  if (blocks.length < MIN_BLOCKS) return null;

  const today = todayIso();
  const fresh = freshOf(blocks, state, today);
  if (fresh.length > MAX_BLOCK_CALLS()) {
    audit("block", `${blocks.length} bloków, aż ${fresh.length} nieznanych — to wygląda na `
      + `przebudowę serwisu, więc jedno wywołanie na całość zamiast ${fresh.length}`,
    { blocks: blocks.length, fresh: fresh.length, limit: MAX_BLOCK_CALLS() });
    return null;
  }

  const cached = blocks.length - fresh.length;
  // ODSIEW CHROMU przed wywołaniem, na samych świeżych blokach — te z cache'a i tak są darmowe.
  const { send, skipped } = partitionChrome(fresh);
  auditChrome(skipped, fresh);
  // `url` w śladzie, bo tą drogą chodzą teraz także followupy: bez adresu nie da się odróżnić
  // podziału strony źródła od podziału jej podstrony, a to osobne rozliczenia
  auditSplit(info, blocks, send);

  // PACZKAMI, nie po jednym bloku: prompt systemowy waży ~900 tokenów, więc wywołanie na blok
  // sprowadzało pierwszy przebieg źródła do kilkunastokrotności ceny jednego wywołania na całą
  // stronę (pomiar na `estrada`: 33 wywołania, $0.244). Model podpisuje każdy wpis numerem
  // bloku i po tym numerze wynik wraca na swoje miejsce — przypisanie zostaje, cena spada.
  let note: string | undefined;
  for (const batch of chunk(send)) {
    const result = await extractBatch(batch.map((b) => b.text), url, program);
    for (const [i, b] of batch.entries()) {
      // blok bez pewnego wyniku (ucięta odpowiedź) NIE trafia do cache: zapisany jako
      // „zero wydarzeń" byłby uznany za przeczytany i nigdy nie wróciłby do modelu
      if (result.unsafe.has(i)) continue;
      storeBlock(state, b.hash, result.byBlock.get(i) ?? { events: [], followups: [] }, today);
    }
    if (result.parse) {
      note = result.parse === "truncated"
        ? "odpowiedź modelu ucięta na limicie — część bloków wróci jutro"
        : `nie dało się odczytać odpowiedzi modelu (${result.parse})`;
    }
  }

  // PO ekstrakcji, bo dopiero teraz `state` zna wynik świeżych bloków — jeden krok mówi
  // wtedy naraz, co przyszło z cache'a i za co dziś zapłaciliśmy (patrz block-trail.ts)
  await auditBlockResult(info, blocks, send, state);

  return {
    ...unionOf(blocks, state, today),
    ...(note ? { note } : {}),
    blocks: {
      total: blocks.length, cached, fresh: send.length,
      ...(skipped.length ? { chrome: skipped.length } : {}),
    },
  };
}
