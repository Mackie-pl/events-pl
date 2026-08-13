/**
 * Migawka progów obowiązujących W TYM przebiegu — do raportu (runs.json, discover-runs.json).
 *
 * Po co, skoro progi stoją w commitowanym `config.json`: bo plik mówi, co obowiązuje DZIŚ,
 * a raport sprzed pięciu dni trzeba czytać razem z tym, co obowiązywało WTEDY. Bez migawki
 * odpowiedź na „czemu ten przebieg wyciszył cztery grupy" wymaga odtworzenia stanu repo
 * z tamtej nocy i zgadywania, czy w Actions nie wisiał wtedy jeszcze sekret nadpisujący plik.
 * Z migawką jest to jedno pole obok liczb, które ma tłumaczyć.
 *
 * `fromEnv` jest tu najważniejsze i dlatego istnieje osobno: to jedyna rzecz, której NIE widać
 * w historii repo. Próg z `config.json` zawsze da się odczytać z commita; próg wstawiony
 * sekretem repozytorium nie zostawia śladu nigdzie indziej.
 *
 * Same progi (`tuning`) — sekretów i adresów tu nie ma i być nie może, bo raporty są publiczne.
 */
import { ALL_PARAMS } from "./params.js";
import type { ConfigValue } from "./file.js";

export interface ConfigSnapshot {
  /** efektywne wartości progów: to, czym potok faktycznie się kierował */
  values: Record<string, ConfigValue>;
  /** progi, które w tym przebiegu przyszły ze środowiska, nie z pliku (zwykle puste) */
  fromEnv?: string[];
}

/**
 * `get()` oddaje `unknown`; progi to z założenia skalary. Niespodzianka (np. ktoś zrobił z progu
 * listę) ma tu zgasnąć od razu, a nie wylądować w raporcie jako `[object Object]`.
 */
const scalar = (name: string, v: unknown): ConfigValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  throw new Error(`${name}: próg musi być skalarem, jest ${typeof v}`);
};

export function configSnapshot(): ConfigSnapshot {
  const values: Record<string, ConfigValue> = {};
  const fromEnv: string[] = [];

  for (const p of ALL_PARAMS) {
    if (p.cls !== "tuning") continue;
    values[p.name] = scalar(p.name, p.get());
    if (p.source() === "env") fromEnv.push(p.name);
  }

  return fromEnv.length ? { values, fromEnv } : { values };
}
