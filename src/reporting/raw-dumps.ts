/**
 * Czytanie zarchiwizowanych zrzutów stron (`raw/`) na potrzeby pomiarów.
 *
 * Osobno od adaptera archiwum, bo to warstwa ODCZYTU dla raportów: potok tylko pisze.
 * Kopia lokalna leży w katalogu tymczasowym systemu, nie w repo — to megabajty cudzego
 * HTML-a, których nie wolno publikować, a które przy każdym kolejnym pomiarze chce się
 * mieć pod ręką zamiast ciągnąć je znowu z bucketa.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getArchive, listArchive } from "../adapters/supabase-archive.js";

const CACHE_DIR = join(tmpdir(), "events-pl-reuse");

export interface DayText {
  day: string;
  text: string;
}

/** Treść jednego zrzutu — z kopii lokalnej albo z archiwum (i wtedy do kopii). */
export async function rawText(path: string, useCache: boolean): Promise<string | null> {
  const local = join(CACHE_DIR, path);
  if (useCache) {
    try { return await readFile(local, "utf8"); } catch { /* brak kopii — pobieramy */ }
  }
  const body = await getArchive(path);
  if (body === null) return null;
  let text: string;
  try {
    text = (JSON.parse(body) as { text?: string }).text ?? "";
  } catch {
    return null; // obiekt sprzed formatu albo ucięty zapis — pomijamy, to nie awaria
  }
  if (useCache) {
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, text, "utf8");
  }
  return text;
}

/** Dni obecne w archiwum, rosnąco; `limit` przycina do najnowszych. */
export async function archivedDays(limit: number): Promise<string[]> {
  return (await listArchive("raw/"))
    .filter((e) => e.folder && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(-limit);
}

/** Identyfikatory źródeł występujące w tych dniach — rejestr zmienia się w czasie. */
export async function sourceIdsIn(days: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const day of days) {
    for (const e of await listArchive(`raw/${day}/`)) if (e.folder) ids.add(e.name);
  }
  return [...ids].sort();
}

/** Zrzut jednego źródła z jednego dnia; kilka zrzutów w dniu = bierzemy najdłuższy. */
async function dumpOf(day: string, sourceId: string, useCache: boolean): Promise<string | null> {
  const files = (await listArchive(`raw/${day}/${sourceId}/`)).filter((e) => !e.folder);
  let best: string | null = null;
  for (const f of files) {
    const t = await rawText(`raw/${day}/${sourceId}/${f.name}`, useCache);
    if (t !== null && t.length > (best?.length ?? -1)) best = t;
  }
  return best?.trim() ? best : null;
}

/** Zrzuty jednego źródła w kolejności dni. */
export async function collectSource(
  days: string[], sourceId: string, useCache: boolean,
): Promise<DayText[]> {
  const out: DayText[] = [];
  for (const day of days) {
    const text = await dumpOf(day, sourceId, useCache);
    if (text) out.push({ day, text });
  }
  return out;
}

/** Najświeższy zrzut źródła — baza porównania dla strony pobranej przed chwilą. */
export async function latestDump(
  days: string[], sourceId: string, useCache: boolean,
): Promise<DayText | null> {
  for (const day of [...days].reverse()) {
    const text = await dumpOf(day, sourceId, useCache);
    if (text) return { day, text };
  }
  return null;
}
