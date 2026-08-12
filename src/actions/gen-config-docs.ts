/**
 * Przebudowuje wszystko, co wynika z rejestru parametrów: `npm run config:docs`.
 *
 * Trzy cele, jedno źródło (src/config/params.ts):
 *   .env.example  — cały plik, do skopiowania i uzupełnienia,
 *   README.md     — sama tabela między znacznikami, reszta prozy zostaje nietknięta,
 *   config.json   — same KLUCZE progów; wartości są własnością właściciela projektu
 *                   i generator ich nie dotyka (patrz config/sync-file.ts).
 *
 * Woła się to po każdej zmianie w rejestrze. Test `config.test.ts` przypomni, gdyby się
 * zapomniało — wszystkie trzy pliki muszą być tym, co renderery produkują teraz.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { applyReadmeConfig, freshConfigFile, renderEnvExample } from "../config/index.js";
import { CONFIG_PATH, ENV_EXAMPLE_PATH, README_PATH } from "../shared/paths.js";

/** Zapis tylko przy realnej zmianie — inaczej każdy przebieg brudziłby drzewo robocze. */
function write(path: string, next: string): void {
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf-8");
  } catch { /* nie ma pliku — zapiszemy go poniżej */ }

  if (current === next) {
    console.log(`bez zmian: ${path}`);
    return;
  }
  writeFileSync(path, next, "utf-8");
  console.log(`zapisano ${path}`);
}

write(CONFIG_PATH, freshConfigFile());
write(ENV_EXAMPLE_PATH, renderEnvExample());
write(README_PATH, applyReadmeConfig(readFileSync(README_PATH, "utf-8")));
