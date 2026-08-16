/**
 * RACHUNEK SONDY FANPAGE'ÓW — czy fanpage instytucji jest wart tego, co płacimy tablicom
 * ogłoszeń.
 *
 * Pytanie brzmi „czym zastąpić grupy", a nie „ile dał fanpage", więc liczby muszą być
 * PORÓWNYWALNE z tym, czym mierzymy grupy (`SourceYield.usdPerNovel`). Stąd ta sama
 * definicja nowości: wydarzenie jest `novel`, gdy nie dało go żadne źródło SPOZA FB.
 * Inna definicja dałaby dwie kolumny, których nie wolno zestawić, a które i tak każdy
 * zestawi.
 *
 * Druga liczba, `alsoInGroups`, jest tą, na którą naprawdę czekamy: ile z tego, co dał
 * fanpage, dostajemy już z płatnych grup. Wysoka wartość znaczy, że fanpage kupuje to samo
 * taniej (można zamieniać), niska — że oba kanały niosą co innego (nie można). Bez niej
 * „fanpage dał 12 wydarzeń" nie odpowiada na żadne pytanie, bo grupy dają ich 72 dziennie.
 *
 * BAZA ODNIESIENIA JEST Z OKNA `runs.json` (7 dni) I Z `events.json`. Okno jest krótkie
 * świadomie — reguły ekstrakcji zmieniają się z tygodnia na tydzień — ale to znaczy, że
 * wydarzenie sprzed dwóch tygodni, o którym strona już nie pisze, policzy się jako nowe.
 * Przy jednorazowej sondzie to szum do przyjęcia; przy stałym progu już nie.
 */
import { eventKey } from "../shared/event-key.js";
import type { EventItem, RunReport, SourceRun } from "../types/index.js";

import { channelOf } from "./source-yield.js";

/** Klucze, które potok już zna — z okna przebiegów i z opublikowanego events.json. */
export interface Baseline {
  /** dały je źródła SPOZA FB — nośnik `novel`, tak samo jak w source-yield */
  web: Set<string>;
  /** dały je grupy FB — nośnik `alsoInGroups` */
  groups: Set<string>;
}

export function buildBaseline(
  runs: readonly RunReport[], published: readonly EventItem[],
): Baseline {
  const web = new Set<string>();
  const groups = new Set<string>();
  for (const run of runs) {
    if (run.stage !== "daily") continue;
    for (const s of run.sources) {
      const target = channelOf(s.fetch) === "web" ? web : groups;
      for (const ref of s.produced ?? []) target.add(ref.key ?? eventKey(ref.title, ref.date));
    }
  }
  // opublikowane wydarzenia niosą `source_id`, więc wiadomo, do którego worka trafiają;
  // bez tego wydarzenie ze strony wypadłoby z bazy tylko dlatego, że okno runs.json jest krótsze
  for (const ev of published) {
    const key = eventKey(ev.title, ev.date_start);
    if (/fb|facebook/i.test(ev.source_id ?? "")) groups.add(key); else web.add(key);
  }
  return { web, groups };
}

export interface FbPageResult {
  id: string;
  name: string;
  town: string;
  url: string;
  bucket: string;
  status: SourceRun["status"];
  /** rekordy Bright Data — jednostka rozliczeniowa, nie posty */
  records: number;
  posts: number;
  /** limit wyczerpany → plon jest ucięty, a nie zmierzony */
  atLimit: boolean;
  events: number;
  novel: number;
  alsoInGroups: number;
  bdUsd: number;
  llmUsd: number;
  costUsd: number;
  usdPerNovel?: number;
  /** co konkretnie — bez tytułów liczba „7 wydarzeń" nie daje się ocenić okiem */
  titles: string[];
  err?: string;
}

export interface ScoreInput {
  meta: { id: string; name: string; town: string; url: string; bucket: string };
  run: SourceRun;
  events: readonly EventItem[];
  baseline: Baseline;
  bdPerRecord: number;
}

/** Rachunek jednego fanpage'a po sondzie. `novel` liczone na kluczach, więc seria to jeden wpis. */
export function scorePage(input: ScoreInput): FbPageResult {
  const { meta, run, events, baseline, bdPerRecord } = input;
  const keys = new Set(events.map((e) => eventKey(e.title, e.date_start)));
  let novel = 0;
  let alsoInGroups = 0;
  for (const k of keys) {
    if (baseline.web.has(k)) continue;
    novel++;
    if (baseline.groups.has(k)) alsoInGroups++;
  }
  const records = run.bd?.records ?? 0;
  const bdUsd = records * bdPerRecord;
  const llmUsd = run.llm.costUsd;
  const costUsd = bdUsd + llmUsd;
  return {
    ...meta,
    status: run.status,
    records,
    posts: run.fbGroup?.posts ?? 0,
    atLimit: run.fbGroup?.atLimit ?? false,
    events: keys.size,
    novel,
    alsoInGroups,
    bdUsd: round(bdUsd),
    llmUsd: round(llmUsd),
    costUsd: round(costUsd),
    ...(novel ? { usdPerNovel: round(costUsd / novel) } : {}),
    titles: [...new Set(events.map((e) => e.title))].slice(0, 12),
    ...(run.err ? { err: run.err } : {}),
  };
}

const round = (n: number): number => Number(n.toFixed(4));

/**
 * Plan wydatku PRZED pierwszym triggerem. Sonda kupuje rekordy w pętli po źródłach — czyli
 * dokładnie w kształcie awarii z 2026-08-10 — więc sufit musi być policzony z góry, a nie
 * sprawdzany po fakcie. Nadmiarowe fanpage'e wypadają z listy, zamiast uciąć budżet w połowie.
 */
export function planBudget(
  ids: readonly string[], limitPerPage: number, maxRecords: number,
): { take: string[]; skipped: string[]; plannedRecords: number } {
  const capacity = Math.max(0, Math.floor(maxRecords / Math.max(1, limitPerPage)));
  const take = ids.slice(0, capacity);
  return {
    take: [...take],
    skipped: ids.slice(capacity),
    plannedRecords: take.length * limitPerPage,
  };
}

export interface FbPagesReport {
  generated: string;
  /** okno przebiegów, z którego liczona jest baza odniesienia */
  from: string;
  to: string;
  budget: {
    limitPerPage: number;
    maxRecords: number;
    plannedRecords: number;
    spentRecords: number;
    skippedForBudget: string[];
  };
  pages: FbPageResult[];
  /** grupy FB tej samej gminy — kolumna, z którą fanpage'e mają się porównać */
  groups: Array<{ id: string; town: string; novel: number; costUsd: number; usdPerNovel?: number }>;
  totals: { records: number; costUsd: number; events: number; novel: number; alsoInGroups: number };
}
