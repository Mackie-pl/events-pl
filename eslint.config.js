// Konfiguracja ESLinta dla potoku (src/). ESM — package.json ma "type": "module".
// panel/ ma własny eslint.config.mjs (Angular + własny tsconfig) i jest tu wyłączony.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { functionRules, sizeRules } from "./eslint.shared.js";

export default defineConfig([
  // node_modules/** i pliki kropkowe flat config ignoruje sam; tu tylko to, co naprawdę trzeba:
  // panel/** bo jego pliki nie należą do rootowego tsconfiga (projectService by się wywalił),
  // .claude/** bo trzyma worktree'y agenta — kopie repo, które lintowały się drugi raz
  // (lokalnie 60 problemów zamiast 30 w CI) i to na nieaktualnym kodzie.
  globalIgnores(["dist/**", "_site/**", "panel/**", "coverage/**", ".claude/**"]),
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      // Typowane, nie zwykłe „recommended": tsc już pilnuje strict + noUncheckedIndexedAccess,
      // więc wartość dodana to reguły, których typechecker nie ma — przede wszystkim
      // no-floating-promises (zgubiony await na persistRun/recordCosts po cichu gubi dane).
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      // Dwa projekty, nie projectService: bazowy tsconfig ma include: ["src/**/*.ts"],
      // więc sam z siebie nie widziałby katalogu test/.
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Martwe // eslint-disable mają wywalać CI, a nie zarastać.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...sizeRules,
      ...functionRules,
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none",
      }],

      // --- korekty presetu „stylistic": reguły czysto kosmetyczne, które przepisałyby
      // --- kilkadziesiąt miejsc bez łapania ani jednego błędu. Wyłączone świadomie, nie z lenistwa.

      // process.env["KLUCZ"] to konwencja całego repo (i wymóg panelu, który ma
      // noPropertyAccessFromIndexSignature). Ta opcja zwalnia dokładnie dostęp przez
      // index signature, a resztę reguły zostawia włączoną.
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
      // Array<T> vs T[] — arbitralne; repo używa Array<T> tam, gdzie T jest obiektem inline.
      "@typescript-eslint/array-type": "off",
      // type vs interface — repo używa `type` dla aliasów unii i kształtów jednorazowych.
      "@typescript-eslint/consistent-type-definitions": "off",
      // .match() vs .exec() — bez /g są równoważne; przepisanie 6 miejsc niczego nie naprawia.
      "@typescript-eslint/prefer-regexp-exec": "off",
      // `env["A"] || env["B"]` to świadomy wzorzec: pusty string ma przepuścić fallback dalej,
      // czego `??` nie robi (patrz komentarz nad supabaseKey w adapters/supabase-archive.ts).
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],
    },
  },
  // Pliki .js (ten config, eslint.shared.js) nie są w tsconfigu — reguły typowane by na nich padły.
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  // Prompty PL: zawijanie linii zmienia treść wysyłaną do modelu.
  { files: ["src/pipeline/prompts.ts", "src/prompts.ts"], rules: { "max-len": "off" } },
  {
    files: ["test/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": "off",
      "max-statements": "off",
      // describe()/it() z node:test zwracają promisy, którymi zarządza runner —
      // obwieszanie każdego bloku `void` byłoby szumem, a nie bezpieczeństwem.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
]);
