/**
 * Porównanie dwóch niezależnych przebiegów daily z (mniej więcej) tego samego stanu źródeł —
 * narzędzie eksploracyjne do szukania szumu w potoku: flaky fetch, wariancja ekstrakcji LLM,
 * niedeterministyczny geokoding. Zakłada dwa katalogi z osobnymi checkoutami repo, każdy po
 * własnym `npm run daily` (patrz .github/workflows/noise-check.yml) — NIE czyta ze storage/,
 * bo to nie jest przebieg produkcyjny i nic tu nie powinno dotykać repo.
 *
 * Uruchomienie: tsx src/actions/diff-runs.ts <dir-a> <dir-b>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { P } from "../config/index.js";

interface RunEntry {
  sources: Array<{
    id: string; status: string; events: number; httpStatus?: number; chars?: number; err?: string;
  }>;
}

interface EventsFile {
  events: Array<{ title: string; date_start: string; source_id?: string }>;
  errors: Array<{ id: string; err: string }>;
}

async function loadLastRun(dir: string): Promise<RunEntry> {
  const raw = await readFile(join(dir, "runs.json"), "utf-8");
  const runs = JSON.parse(raw) as RunEntry[];
  const last = runs.at(-1);
  if (!last) throw new Error(`${dir}/runs.json: brak przebiegów`);
  return last;
}

async function loadEvents(dir: string): Promise<EventsFile> {
  return JSON.parse(await readFile(join(dir, "events.json"), "utf-8")) as EventsFile;
}

function diffSource(id: string, a?: RunEntry["sources"][number], b?: RunEntry["sources"][number]): string | null {
  if (!a || !b) return `${id}: obecne tylko w ${a ? "A" : "B"}`;
  if (a.status === b.status && a.events === b.events && a.httpStatus === b.httpStatus) return null;
  const httpPart = a.httpStatus !== b.httpStatus ? ` · http ${a.httpStatus}→${b.httpStatus}` : "";
  return `${id}: status ${a.status}→${b.status} · zdarzenia ${a.events}→${b.events}${httpPart}`;
}

async function main(): Promise<void> {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) throw new Error("użycie: diff-runs.ts <dir-a> <dir-b>");

  const [runA, runB, evA, evB] = await Promise.all([
    loadLastRun(dirA), loadLastRun(dirB), loadEvents(dirA), loadEvents(dirB),
  ]);

  const byId = (run: RunEntry) => new Map(run.sources.map((s) => [s.id, s]));
  const mapA = byId(runA);
  const mapB = byId(runB);
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

  const diffs: string[] = [];
  for (const id of allIds) {
    const d = diffSource(id, mapA.get(id), mapB.get(id));
    if (d) diffs.push(d);
  }

  console.log(`Przebieg A: ${evA.events.length} wydarzeń, ${evA.errors.length} błędów`);
  console.log(`Przebieg B: ${evB.events.length} wydarzeń, ${evB.errors.length} błędów`);
  console.log(`Źródła porównane: ${allIds.size}, różniących się: ${diffs.length}`);

  if (diffs.length) {
    for (const d of diffs) console.log(`  ${d}`);
    if (P.GITHUB_ACTIONS.get()) {
      const msg = `noise-check: ${diffs.length}/${allIds.size} źródeł dało różny wynik między A i B`;
      console.log(`::warning::${msg} — patrz log`);
    }
  } else {
    console.log("brak różnic — oba przebiegi identyczne na poziomie źródeł");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
