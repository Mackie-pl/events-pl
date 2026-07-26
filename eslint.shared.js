// Wspólne progi „kto to przeczyta" — używane przez eslint.config.js (root) i panel/eslint.config.mjs.
//
// Ten plik NIE MOŻE mieć importów. panel/ to osobny projekt npm z własnym node_modules,
// więc każdy `import` wtyczki rozwiązywałby się względem roota i wysypywał lint panelu.
// Eksportujemy wyłącznie zwykłe obiekty — konfiguracja flat ESLinta to i tak POJO.

/**
 * Progi rozmiaru PLIKU i linii — egzekwowane twardo, CI się na nich wywraca.
 * Liczone BEZ pustych linii i komentarzy: gęsty polski JSDoc w tym repo jest
 * dokumentacją decyzji, a nie długiem — reguła, która każe go kasować, szkodzi.
 */
export const sizeRules = {
  "max-lines": ["error", { max: 350, skipBlankLines: true, skipComments: true }],
  "max-depth": ["error", 4],
  "max-params": ["error", 4],
  "max-nested-callbacks": ["error", 3],
  // Bez ignoreStrings/ignoreTemplateLiterals: te opcje pomijają całą linię *zawierającą* string,
  // a tu prawie każda długa linia to składany szablon — reguła zostałaby wydrążona do zera.
  "max-len": ["error", { code: 120, tabWidth: 2, ignoreUrls: true, ignoreRegExpLiterals: true }],
};

/**
 * Progi ZŁOŻONOŚCI FUNKCJI. Na razie ostrzeżenia, nie błędy — stan na 2026-07-26.
 *
 * Zostało osiem funkcji ponad progiem i wszystkie są orkiestratorami wejścia/wyjścia:
 *   actions/daily.ts        run
 *   actions/discover.ts     main
 *   adapters/brave.ts       webSearch
 *   adapters/brightdata.ts  collect
 *   adapters/openrouter.ts  chat
 *   pipeline/discover/discover-town.ts        discoverTown
 *   pipeline/extract/process-source.ts        processFollowup, processSource
 *   pipeline/verify/verify-source.ts          verifySource
 *
 * Dla żadnej z nich NIE MA darmowej wyroczni: sprawdzenie ich wymaga OpenRoutera,
 * Brave albo Bright Data, czyli płatnego przebiegu. Wszystko, co dało się rozciąć
 * pod osłoną testu albo wyjścia bajt-w-bajt, zostało rozcięte; te osiem zostaje
 * ostrzeżeniem, dopóki nie dostaną testów z podstawionymi adapterami.
 *
 * Podnoszenie progów „żeby było zielono" mija się z celem — próg ma boleć.
 */
export const functionRules = {
  "max-lines-per-function": ["warn", { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
  complexity: ["warn", { max: 10 }],
  "max-statements": ["warn", { max: 25 }],
};

/**
 * Te same progi jako ostrzeżenia — do etapu przejściowego refaktoru i do panelu,
 * którego nie przebudowujemy.
 * @param {Record<string, unknown[]>} rules
 * @returns {Record<string, unknown[]>}
 */
export const asWarnings = (rules) =>
  Object.fromEntries(Object.entries(rules).map(([name, [, ...opts]]) => [name, ["warn", ...opts]]));
