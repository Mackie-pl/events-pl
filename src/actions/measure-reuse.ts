/**
 * ILE Z DZISIEJSZEJ TREŚCI PŁACIMY PO RAZ DRUGI.
 *
 * Pomiar, nie funkcja. Zanim wymienimy cache po haszu CAŁEJ strony (state.json) na cache
 * po blokach, trzeba wiedzieć, czy estrada.poznan.pl — gdzie dzień do dnia przybyło ZERO
 * znaków, a i tak poszła do modelu cała strona — jest regułą, czy wyjątkiem. Rejestr ma
 * 46 źródeł i widać po nich, że bywa różnie: `dopiewo-city` skacze 3 → 12 → 47 → 55 wydarzeń,
 * co może być prawdziwym ruchem na stronie równie dobrze jak artefaktem zmiany wejścia.
 *
 * Dane są już zebrane: `archiveRaw()` od zawsze zapisuje `raw/{dzień}/{źródło}/{hash}.json`
 * z treścią 1:1 taką, jaką dostał model. Ten skrypt tylko ją czyta.
 *
 *   npm run measure-reuse                # ostatnie 14 dni z archiwum
 *   npm run measure-reuse -- --days=30
 *   npm run measure-reuse -- --source=estrada
 *   npm run measure-reuse -- --no-cache  # pomiń kopię lokalną, pobierz wszystko od nowa
 *   npm run measure-reuse -- --dry       # policz i wypisz, ale nie zapisuj reuse.json
 *
 * ZAPISUJE DWA WYNIKI W DWA RÓŻNE MIEJSCA, i ten podział jest tu najważniejszą decyzją:
 *   reuse.json (repo, publiczne)  — same liczby, hashe i ścieżki. Zero treści stron.
 *   reuse/<źródło>.json (bucket)  — fragmenty, które mimo cache'a poszłyby do modelu.
 * Panel czyta pierwsze zawsze, drugie tylko przez most na localhoście — tak samo jak zrzuty
 * `raw/`. Wrzucenie przykładów do repo byłoby publikacją cudzych treści bez redakcji PII.
 *
 * Pobrane zrzuty lądują w katalogu tymczasowym systemu: megabajty cudzego HTML-a, których
 * nie wolno publikować, a które przy kolejnym uruchomieniu chce się mieć pod ręką.
 */
import { archiveEnabled, put } from "../adapters/supabase-archive.js";
import { DEFAULT_SEGMENT, ceilingReuse, reuseAgainst, segment } from "../pipeline/extract/blocks.js";
import { type DayText, archivedDays, collectSource, sourceIdsIn } from "../reporting/raw-dumps.js";
import { collection, doc } from "../storage/index.js";
import type { ReusePair, ReuseReport, ReuseSamples, ReuseSource, RunReport } from "../types/index.js";

/** Ile świeżych bloków trafia do przykładu. Ma ILUSTROWAĆ, a nie archiwizować drugi raz. */
const SAMPLE_BLOCKS = 3;
const SAMPLE_CHARS = 4000;

const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Koszt LLM per `dzień|źródło` z raportów przebiegów. Retencja runs.json bywa krótsza niż archiwum. */
async function costIndex(): Promise<Map<string, number>> {
  const runs = await collection<RunReport>("runs", { at: (r) => r.startedAt }).all();
  const usd = new Map<string, number>();
  for (const r of runs) {
    if (r.stage !== "daily") continue;
    for (const s of r.sources) usd.set(`${r.startedAt.slice(0, 10)}|${s.id}`, s.llm.costUsd);
  }
  return usd;
}

/**
 * Jedno źródło przez całe okno. Cache bloków rośnie przez kolejne dni — dokładnie tak,
 * jak rósłby w potoku — więc kolejność zrzutów ma tu znaczenie i jest chronologiczna.
 * Pierwszy dzień tylko zapełnia cache: nie ma z czym go porównać, więc nie liczy się do oszczędności.
 */
function measureSource(
  id: string, shots: DayText[], usd: Map<string, number>,
): { row: ReuseSource; samples: ReuseSamples } {
  const seen = new Set<string>();
  reuseAgainst(segment(shots[0]!.text), seen);

  const row: ReuseSource = {
    id, followup: id.endsWith("__followup"), days: shots.length,
    chars: 0, ceiling: 0, reuse: 0, freeDays: 0, freeUsd: 0, shrinkUsd: 0, pairs: [],
  };
  const samples: ReuseSamples = { id, generated: new Date().toISOString(), pairs: [] };
  let ceilSum = 0, reuseSum = 0;

  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1]!, cur = shots[i]!;
    const stat = reuseAgainst(segment(cur.text), seen);
    const ceiling = ceilingReuse(prev.text, cur.text);
    const money = usd.get(`${cur.day}|${id}`);
    const pair: ReusePair = {
      day: cur.day, prev: prev.day, chars: stat.chars, blocks: stat.blocks,
      newBlocks: stat.newBlocks, newChars: stat.newChars, ceiling, reuse: stat.reuse,
      ...(money === undefined ? {} : { usd: money }),
    };
    row.pairs.push(pair);
    row.chars += stat.chars;
    ceilSum += ceiling * stat.chars;
    reuseSum += stat.reuse * stat.chars;
    if (stat.newBlocks === 0) {
      row.freeDays++;
      row.freeUsd += money ?? 0;
    } else {
      row.shrinkUsd += (money ?? 0) * stat.reuse;
      samples.pairs.push({
        day: cur.day, prev: prev.day,
        newBlocks: stat.fresh.slice(0, SAMPLE_BLOCKS)
          .map((b) => ({ hash: b.hash, chars: b.chars, text: b.text.slice(0, SAMPLE_CHARS) })),
        omitted: Math.max(0, stat.fresh.length - SAMPLE_BLOCKS),
      });
    }
  }
  row.ceiling = row.chars ? ceilSum / row.chars : 0;
  row.reuse = row.chars ? reuseSum / row.chars : 0;
  return { row, samples };
}

function printReport(rep: ReuseReport): void {
  console.log(
    "źródło".padEnd(26) + "dni".padStart(4) + "znaki".padStart(9) +
    "sufit".padStart(8) + "bloki".padStart(8) + "darmo".padStart(7) + "$pewne".padStart(9) + "$szac.".padStart(9),
  );
  for (const r of rep.sources) {
    console.log(
      r.id.slice(0, 25).padEnd(26) + String(r.days).padStart(4) + String(r.chars).padStart(9) +
      pct(r.ceiling).padStart(8) + pct(r.reuse).padStart(8) + `${r.freeDays}/${r.days - 1}`.padStart(7) +
      r.freeUsd.toFixed(3).padStart(9) + r.shrinkUsd.toFixed(3).padStart(9),
    );
  }
  const t = rep.totals;
  console.log(
    `\nRAZEM ${t.chars} znaków w ${t.pairs} porównaniach dzień-do-dnia.\n` +
    `  sufit (wiersze widziane wczoraj):        ${pct(t.ceiling)}\n` +
    `  odzyskane przez bloki:                   ${pct(t.reuse)}\n` +
    `  źródło-dni bez ani jednego nowego bloku: ${t.freeDays}/${t.pairs} (${pct(t.freeDays / t.pairs)})\n` +
    `  rachunek: $${t.freeUsd.toFixed(2)} pewne + ~$${t.shrinkUsd.toFixed(2)} szacowane` +
    ` z $${(t.freeUsd + t.shrinkUsd).toFixed(2)} objętych pomiarem`,
  );
}

function totals(sources: ReuseSource[]): ReuseReport["totals"] {
  const sum = (f: (r: ReuseSource) => number): number => sources.reduce((a, r) => a + f(r), 0);
  const chars = sum((r) => r.chars);
  return {
    chars,
    pairs: sum((r) => r.days - 1),
    ceiling: chars ? sum((r) => r.ceiling * r.chars) / chars : 0,
    reuse: chars ? sum((r) => r.reuse * r.chars) / chars : 0,
    freeDays: sum((r) => r.freeDays),
    freeUsd: sum((r) => r.freeUsd),
    shrinkUsd: sum((r) => r.shrinkUsd),
  };
}

/** Wszystkie źródła okna; te z jednym zrzutem odpadają — nie ma ich z czym porównać. */
async function measureAll(
  days: string[], ids: string[], useCache: boolean, usd: Map<string, number>,
): Promise<{ sources: ReuseSource[]; allSamples: ReuseSamples[] }> {
  const sources: ReuseSource[] = [];
  const allSamples: ReuseSamples[] = [];
  for (const id of ids) {
    const shots = await collectSource(days, id, useCache);
    if (shots.length < 2) continue;
    const { row, samples } = measureSource(id, shots, usd);
    if (samples.pairs.length) {
      row.samples = `reuse/${id}.json`;
      allSamples.push(samples);
    }
    sources.push(row);
  }
  return { sources, allSamples };
}

/**
 * Liczby do repo, treść do prywatnego archiwum. Ten podział jest tu jedyną rzeczą
 * pilnującą, żeby cudze strony nie wyciekły do publicznego repozytorium.
 */
async function persist(report: ReuseReport, samples: ReuseSamples[]): Promise<void> {
  await doc<ReuseReport>("reuse", () => report).save(report);
  let stored = 0;
  for (const s of samples) {
    if (await put(`reuse/${s.id}.json`, JSON.stringify(s, null, 1))) stored++;
  }
  console.log(
    `\nZapisano reuse.json (${report.sources.length} źródeł) oraz ${stored}/${samples.length} ` +
    "kompletów przykładów w prywatnym archiwum.\n" +
    "  Panel: zakładka Reuse. Przykłady widać wyłącznie przy działającym `npm run panel-server`.",
  );
}

async function main(): Promise<void> {
  if (!archiveEnabled()) {
    console.log(
      "Archiwum wyłączone — bez SUPABASE_URL i SUPABASE_SECRET_KEY nie ma czego mierzyć.\n" +
      "  Treść stron leży wyłącznie w prywatnym buckecie (raw/), w repo są tylko metryki.",
    );
    return;
  }
  const useCache = !process.argv.includes("--no-cache");
  const dry = process.argv.includes("--dry");
  const onlySource = arg("source", "");

  const days = await archivedDays(Number(arg("days", "14")));
  if (days.length < 2) {
    console.log(`Za mało dni w archiwum (${days.length}) — pomiar potrzebuje co najmniej dwóch.`);
    return;
  }
  const ids = (await sourceIdsIn(days)).filter((id) => !onlySource || id === onlySource);

  const usd = await costIndex();
  console.log(`Archiwum: ${days.length} dni (${days[0]} … ${days.at(-1)}), ${ids.length} źródeł.\n`);

  const { sources, allSamples } = await measureAll(days, ids, useCache, usd);
  if (!sources.length) {
    console.log("Żadne źródło nie ma dwóch zrzutów w tym oknie — nie ma czego porównywać.");
    return;
  }
  // marnotrawstwo najpierw: pierwszy wiersz ma być tym, na który warto popatrzeć
  sources.sort((a, b) => (b.freeUsd + b.shrinkUsd) - (a.freeUsd + a.shrinkUsd) || b.chars - a.chars);

  const report: ReuseReport = {
    generated: new Date().toISOString(),
    from: days[0]!, to: days.at(-1)!, days: days.length,
    segment: { maxChars: DEFAULT_SEGMENT.maxChars, targetParas: DEFAULT_SEGMENT.targetParas },
    totals: totals(sources),
    sources,
  };
  printReport(report);

  if (dry) {
    console.log("\n--dry: nic nie zapisano.");
    return;
  }
  await persist(report, allSamples);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
