// @ts-check
// .mjs, a nie .js: panel/package.json nie ma "type": "module", więc zwykły .js byłby CommonJS
// i nie mógłby zaciągnąć wspólnych progów z ../eslint.shared.js (ESM).
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

import { asWarnings, functionRules, sizeRules } from '../eslint.shared.js';

export default defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // Te same progi co w potoku, ale jako ostrzeżenia: panelu w tym refaktorze nie
      // przebudowujemy, a jego największy plik (types.ts, 335 linii kodu) i tak mieści się
      // w limicie 350. Ostrzeżenia pokazują dług, nie blokując builda.
      ...asWarnings(sizeRules),
      ...functionRules,
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
