// Wspólne progi „kto to przeczyta" — używane przez eslint.config.js (root) i panel/eslint.config.mjs.
//
// Ten plik NIE MOŻE mieć importów. panel/ to osobny projekt npm z własnym node_modules,
// więc każdy `import` wtyczki rozwiązywałby się względem roota i wysypywał lint panelu.
// Eksportujemy wyłącznie zwykłe obiekty — konfiguracja flat ESLinta to i tak POJO.

/**
 * Progi rozmiaru. Liczone BEZ pustych linii i komentarzy: gęsty polski JSDoc w tym repo
 * jest dokumentacją decyzji, a nie długiem — reguła, która każe go kasować, szkodzi.
 */
export const sizeRules = {
  "max-lines": ["error", { max: 350, skipBlankLines: true, skipComments: true }],
  "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
  complexity: ["error", { max: 10 }],
  "max-depth": ["error", 4],
  "max-params": ["error", 4],
  "max-statements": ["error", { max: 25 }],
  "max-nested-callbacks": ["error", 3],
  // Bez ignoreStrings/ignoreTemplateLiterals: te opcje pomijają całą linię *zawierającą* string,
  // a tu prawie każda długa linia to składany szablon — reguła zostałaby wydrążona do zera.
  "max-len": ["error", { code: 120, tabWidth: 2, ignoreUrls: true, ignoreRegExpLiterals: true }],
};

/**
 * Te same progi jako ostrzeżenia — do etapu przejściowego refaktoru i do panelu,
 * którego nie przebudowujemy.
 * @param {Record<string, unknown[]>} rules
 * @returns {Record<string, unknown[]>}
 */
export const asWarnings = (rules) =>
  Object.fromEntries(Object.entries(rules).map(([name, [, ...opts]]) => [name, ["warn", ...opts]]));
