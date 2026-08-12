/**
 * Trzyma `config.json` w zgodzie z rejestrem: dokłada progi, które doszły, usuwa te, których
 * już nie ma, i porządkuje kolejność. WARTOŚCI ZOSTAJĄ NIETKNIĘTE — plik jest po to, żeby
 * właściciel projektu je zmieniał, a generator, który by je nadpisywał wartościami domyślnymi,
 * kasowałby dokładnie to, co ma chronić.
 *
 * Stąd też sortowanie w kolejności DEKLARACJI, nie alfabetycznie: dopisany próg ląduje wtedy
 * przy swojej grupie, a nie losowo w środku pliku, więc diff pokazuje jedną linię zamiast
 * przetasowania.
 */
import { ALL_PARAMS } from "./params.js";
import { configFile, resetConfigFile } from "./file.js";
import type { ConfigValue } from "./file.js";

const HEADER_NOTE = "_";

/**
 * Klucze progów w kolejności deklaracji. `_` na początku to nie próg, tylko notka dla kogoś,
 * kto otworzy plik bez kontekstu — JSON nie ma komentarzy, a plik ma być czytany ręcznie.
 */
export const NOTE_TEXT =
  "Progi potoku. Zmiana ma zostawiać ślad w git log — patrz src/config/params.ts. "
  + "Klucze pilnuje `npm run config:docs`, wartości są Twoje.";

export function renderConfigFile(current: Readonly<Record<string, ConfigValue>>): string {
  const out: Record<string, ConfigValue> = { [HEADER_NOTE]: NOTE_TEXT };

  for (const p of ALL_PARAMS) {
    if (p.cls !== "tuning") continue;
    // wartość z pliku ma pierwszeństwo przed domyślną — także wtedy, gdy jest nią `null`
    out[p.name] = p.name in current ? (current[p.name] ?? null) : p.defaultJson;
  }

  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Świeży render na podstawie tego, co leży na dysku (albo pustki, gdy pliku jeszcze nie ma). */
export function freshConfigFile(): string {
  resetConfigFile(); // plik mógł się zmienić od pierwszego odczytu w tym procesie
  return renderConfigFile(configFile());
}
