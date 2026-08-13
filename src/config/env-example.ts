/**
 * Renderuje `.env.example` z rejestru. Plik jest WYNIKIEM, nie źródłem — edycja ręczna
 * przepada przy najbliższym `npm run env:example`, a test pilnuje, żeby nie dało się
 * zacommitować wersji rozjechanej z kodem.
 *
 * Parametry klasy `ambient` się nie renderują: GITHUB_ACTIONS i GITHUB_STEP_SUMMARY daje
 * runner, wpisanie ich do .env niczego nie załatwia, a w rejestrze są po to, żeby lista
 * odczytów środowiska była kompletna.
 */
import { GROUPS } from "./groups.js";
import { ALL_PARAMS } from "./params.js";
import type { Param } from "./param.js";

const PREAMBLE = [
  "PLIK GENEROWANY — nie edytuj ręcznie. Źródłem jest src/config/params.ts,",
  "przebuduj przez `npm run config:docs` (test config.test.ts pilnuje zgodności).",
  "",
  "Skopiuj do .env i uzupełnij. .env jest w .gitignore — nigdy go nie commituj.",
  "Wczytywane automatycznie przez npm run daily/digest/discover/probe/panel-server",
  "(node --env-file-if-exists, bez dodatkowych zależności).",
  "Na GH Actions pliku nie ma — tam te same nazwy przychodzą z repo secrets.",
  "",
  "PROGI POTOKU MIESZKAJĄ W config.json, nie tutaj. Wpisy poniżej i tak działają — env ma",
  "pierwszeństwo — ale zmiana w .env albo w sekretach repo nie zostawia śladu nigdzie,",
  "a ta sama zmiana w config.json ma datę, autora i diff. Env do doraźnego eksperymentu,",
  "config.json do decyzji. Wartości pokazane niżej to domyślne z rejestru.",
];

/** Szerokość, do której dociągamy `NAME=wartość`, zanim dopiszemy komentarz na prawo. */
const NOTE_COLUMN = 32;

const comment = (lines: readonly string[]): string[] =>
  lines.map((l) => (l ? `# ${l}` : "#"));

function entry(p: Param<unknown>): string[] {
  const value = p.example ?? p.defaultText;
  const assignment = `${p.fill ? "" : "# "}${p.name}=${value}`;
  // `summary` idzie obok KAŻDEGO wpisu, także tego z blokiem prozy nad nim: blok tłumaczy
  // decyzję, a przy samym przypisaniu chce się przeczytać, co ta liczba w ogóle znaczy.
  return [...comment(p.doc ?? []), `${assignment.padEnd(NOTE_COLUMN)}  # ${p.summary}`];
}

export function renderEnvExample(): string {
  const out = [...comment(PREAMBLE)];

  for (const group of GROUPS) {
    const params = ALL_PARAMS.filter((p) => p.group === group.id && p.cls !== "ambient");
    if (!params.length) continue;

    out.push("", `# --- ${group.title} ---`);
    params.forEach((p, i) => {
      // blok prozy dostaje oddech nad sobą; wpisy jednolinijkowe zostają zbite w tabelkę
      if (i > 0 && p.doc?.length) out.push("#");
      out.push(...entry(p));
    });
  }

  return `${out.join("\n")}\n`;
}
