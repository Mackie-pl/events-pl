/**
 * Wspólne wczytanie ŻYWYCH danych z repo dla testów kontraktowych (`npm run test:live`).
 *
 * Te testy czytają to, co faktycznie leży w repo po ostatnim przebiegu, i pilnują reguł,
 * których potok ma dotrzymywać. Zasada, dla której powstały: **danych nie poprawiamy ręcznie**.
 * Gdy w rejestrze widać sprzeczność, nie edytujemy sources.json — piszemy tu asercję, która
 * ją nazywa, i zmieniamy potok tak, żeby następny przebieg wyprodukował dane poprawnie.
 * Test przestaje padać dopiero, gdy poprawka faktycznie zadziałała.
 *
 * Dlatego są osobnym skryptem, a nie częścią `npm test`: `npm test` waliduje KOD i musi być
 * zielony, żeby dało się pracować; ten zestaw waliduje STAN DANYCH i ma prawo świecić na
 * czerwono tygodniami — do najbliższego przebiegu discover/daily.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DiscoverRunReport, EventsFile, RunReport, SourcesFile } from "../../src/types/index.js";

const repoFile = (name: string): string =>
  fileURLToPath(new URL(`../../${name}`, import.meta.url));

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(repoFile(name), "utf8")) as T;
  } catch {
    // brak pliku to nie awaria testu: świeży klon ma tylko część danych, a każdy test
    // sam decyduje, czy bez nich ma co sprawdzać
    return null;
  }
}

export const sourcesFile = (): SourcesFile | null => readJson<SourcesFile>("sources.json");
export const discoverRuns = (): DiscoverRunReport[] => readJson<DiscoverRunReport[]>("discover-runs.json") ?? [];
export const dailyRuns = (): RunReport[] => readJson<RunReport[]>("runs.json") ?? [];
export const eventsFile = (): EventsFile | null => readJson<EventsFile>("events.json");

/**
 * Komunikat porażki w jednym kształcie: co jest złamane, na których rekordach i CO ZMIENIĆ
 * W POTOKU. Ostatnia część jest tu najważniejsza — bez niej test kusi, żeby „naprawić"
 * go ręczną edycją danych, czyli dokładnie tym, czemu ma zapobiegać.
 */
export function report(rule: string, offenders: readonly string[], fix: string): string {
  const shown = offenders.slice(0, 12);
  const more = offenders.length - shown.length;
  return [
    `${rule} — ${offenders.length} rekordów:`,
    ...shown.map((o) => `    · ${o}`),
    ...(more > 0 ? [`    … i jeszcze ${more}`] : []),
    `  POTOK: ${fix}`,
  ].join("\n");
}

/** Najnowszy przebieg discover danego trybu — „czy ostatni przebieg zachował się poprawnie". */
export const latestRun = (mode?: DiscoverRunReport["mode"]): DiscoverRunReport | undefined =>
  discoverRuns().filter((r) => !mode || r.mode === mode).at(-1);
