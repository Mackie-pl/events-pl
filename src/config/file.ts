/**
 * `config.json` — progi potoku wersjonowane w repo, zamiast w sekretach GitHuba.
 *
 * PO CO OSOBNY PLIK, skoro env już działał. Bo zmiana progu w repo secrets nie zostawia
 * ŻADNEGO śladu: nie ma daty, autora ani poprzedniej wartości, więc pytania „od kiedy
 * wyciszamy tak agresywnie" nie da się postawić, a co dopiero odpowiedzieć. Ten sam próg
 * w commitowanym pliku daje `git log -p config.json` — datę, autora, wartość przed i po,
 * do zestawienia z tym, co w tych dniach robił potok (runs.json, audit.json).
 *
 * CO TU WCHODZI: wyłącznie parametry klasy `tuning`. Sekrety nie mają czego szukać w repo
 * publicznym, a wybory typu MODEL_EXTRACT czy adres Supabase są własnością środowiska,
 * nie decyzją, którą warto śledzić w historii. Klasa jest sprawdzana przy odczycie: nawet
 * gdyby ktoś wpisał tu `OPENROUTER_API_KEY`, nie zostanie odczytany.
 *
 * PIERWSZEŃSTWO: `process.env` → `config.json` → wartość domyślna z rejestru. Env na górze,
 * żeby doraźny eksperyment („puść raz z niższym progiem") nie wymagał commita, a testy
 * mogły podmieniać wartości tak jak dotąd.
 *
 * BŁĘDY SĄ GŁOŚNE, inaczej niż przy pojedynczej wartości spoza zakresu. Zła liczba w jednym
 * progu to literówka w jednym pokrętle — wraca wartość domyślna i przebieg leci dalej.
 * Zepsuty JSON to zniknięcie CAŁEJ warstwy progów: potok pojechałby na domyślnych, udając,
 * że wszystko gra. Plik jest commitowany i pilnowany testem, więc awaria wyjdzie w CI, zanim
 * dojedzie do crona — a jak już dojedzie, lepiej, żeby przebieg stanął, niż policzył swoje
 * na wartościach, których nikt nie wybrał.
 */
import { readFileSync } from "node:fs";

import { CONFIG_PATH } from "../shared/paths.js";
import type { ParamClass } from "./param.js";

/** JSON-owe skalary; `null` znaczy „nie ustawiaj", czyli to samo, co brak klucza. */
export type ConfigValue = string | number | boolean | null;

let cache: Readonly<Record<string, ConfigValue>> | null = null;

const isScalar = (v: unknown): v is ConfigValue =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/** Wydzielone z odczytu pliku, żeby dało się to sprawdzić testem bez dotykania dysku. */
export function parseConfig(text: string, where = CONFIG_PATH): Readonly<Record<string, ConfigValue>> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${where}: oczekiwano obiektu {próg: wartość}`);
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!isScalar(v)) {
      throw new Error(`${where}: "${k}" musi być liczbą, tekstem albo true/false`);
    }
  }
  return parsed as Record<string, ConfigValue>;
}

/**
 * Nazwa wyłącznika CAŁEJ warstwy pliku (`CONFIG_FILE=0`). Trzymana tu, a nie brana z rejestru,
 * bo rejestr stoi piętro wyżej i pytanie o niego skończyłoby się cyklem importów. Zgodności
 * z wpisem w rejestrze pilnuje test.
 *
 * Po co to w ogóle jest: env potrafi nadpisać wartość, ale NIE potrafi jej cofnąć do „nieustawionej"
 * — pusty string znaczy „brak", więc spada z powrotem na plik. Bez wyłącznika nie dałoby się
 * uruchomić potoku na samych wartościach domyślnych, a testy sprawdzające ścieżkę „progu nie ma"
 * (np. `FB_MAX_USD_PER_EVENT` niepodane = mechanizm nie działa) robiłyby się czerwone w dniu,
 * w którym ktoś ten próg ustawi. Testy jadą z `CONFIG_FILE=0` — sprawdzają LOGIKĘ przy podanych
 * progach, a nie to, jak właściciel akurat nastroił potok.
 */
export const CONFIG_FILE_SWITCH = "CONFIG_FILE";

function load(): Readonly<Record<string, ConfigValue>> {
  if (process.env[CONFIG_FILE_SWITCH] === "0") return {};
  try {
    return parseConfig(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    // brak pliku = same wartości domyślne; świeży klon ma ruszać bez ceregieli.
    // Każdy INNY błąd (zepsuty JSON, zły kształt) leci dalej — patrz nagłówek modułu.
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return {};
    throw e;
  }
}

export function configFile(): Readonly<Record<string, ConfigValue>> {
  cache ??= load();
  return cache;
}

/** Dla testów i generatora — w jednym przebiegu potoku nikt tego nie woła. */
export function resetConfigFile(): void {
  cache = null;
}

/**
 * Wartość z pliku jako tekst, żeby przeszła przez DOKŁADNIE ten sam parser, co zmienna
 * środowiskowa. Bez tego `FB_MUTE_DAYS: -5` w JSON-ie omijałby walidację, którą to samo
 * `-5` z env przechodzi — a dwie ścieżki wejścia z dwoma zestawami reguł to dwa różne
 * zachowania czekające, aż ktoś je odkryje.
 */
export function configValue(name: string, cls: ParamClass): string | undefined {
  if (cls !== "tuning") return undefined;
  const v = configFile()[name];
  return v === undefined || v === null ? undefined : String(v);
}
