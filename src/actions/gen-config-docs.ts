/**
 * Przebudowuje dokumentację konfiguracji z rejestru parametrów: `npm run config:docs`.
 *
 * Dwa cele, jedno źródło (src/config/params.ts):
 *   .env.example  — cały plik, do skopiowania i uzupełnienia,
 *   README.md     — sama tabela między znacznikami, reszta prozy zostaje nietknięta.
 *
 * Woła się to po każdej zmianie w rejestrze. Test `config.test.ts` przypomni, gdyby się
 * zapomniało — oba pliki muszą być tym, co renderer produkuje teraz.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { applyReadmeConfig, renderEnvExample } from "../config/index.js";
import { ENV_EXAMPLE_PATH, README_PATH } from "../shared/paths.js";

writeFileSync(ENV_EXAMPLE_PATH, renderEnvExample(), "utf-8");
console.log(`zapisano ${ENV_EXAMPLE_PATH}`);

const readme = readFileSync(README_PATH, "utf-8");
const updated = applyReadmeConfig(readme);
if (updated === readme) {
  console.log("README bez zmian");
} else {
  writeFileSync(README_PATH, updated, "utf-8");
  console.log(`zapisano ${README_PATH}`);
}
