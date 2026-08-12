/**
 * Ładowane przez `npm test` (`--import`) PRZED jakimkolwiek plikiem testu.
 *
 * Zdejmuje warstwę `config.json`, więc testy widzą wartości domyślne z rejestru i te, które
 * same podadzą przez `process.env`. Bez tego zmiana progu w config.json — czyli dokładnie to,
 * po co ten plik istnieje — zapalałaby na czerwono testy sprawdzające ścieżkę „progu nie ma",
 * bo env nie umie cofnąć wartości do nieustawionej (patrz src/config/file.ts).
 *
 * Osobny moduł, a nie `VAR=0 node …` w skrypcie npm, bo to składnia bash-a: w PowerShellu
 * (i w cmd, którym npm odpala skrypty na Windowsie) po prostu nie działa.
 */
process.env["CONFIG_FILE"] = "0";
