/**
 * Grupy parametrów — kolejność sekcji w .env.example i w każdym zrzucie konfiguracji.
 *
 * Osobny plik, bo `params.ts` importuje stąd `GroupId`: dzięki temu literówka w `group:`
 * jest błędem kompilacji, a nie sekcją, która po cichu wyparowała z wygenerowanego pliku.
 */
export const GROUPS = [
  { id: "llm", title: "wymagane: ekstrakcja i discovery" },
  { id: "search", title: "discovery / naprawa martwych URL-i" },
  { id: "models", title: "opcjonalnie: ewaluacja innych modeli bez zmian w kodzie" },
  { id: "structured", title: "opcjonalnie: structured outputs (response_format: json_schema)" },
  { id: "fb", title: "opcjonalnie: Facebook przez Bright Data (linki do wydarzeń + otwarte grupy)" },
  { id: "pipeline", title: "potok: sufity i tryby (tokeny, wywołania LLM, punkt wejścia)" },
  { id: "archive", title: "prywatne archiwum treści (Supabase Storage)" },
  { id: "costs", title: "księga kosztów (costs.json)" },
  { id: "digest", title: "digest (Telegram aktywny, e-mail w zapasie)" },
  { id: "endpoints", title: "adresy API — do proxy i mocków w testach, normalnie zostaw puste" },
  { id: "ambient", title: "od środowiska, nie od nas" },
] as const;

export type GroupId = (typeof GROUPS)[number]["id"];
