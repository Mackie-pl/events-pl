/**
 * Rejestr parametrów, część druga: WYJŚCIA DO ŚWIATA — digest (Telegram, e-mail) i adresy usług.
 *
 * Wydzielone z params.ts, kiedy tamten plik dobił do twardego progu 350 linii (2026-08-17).
 * Rejestr jest z natury długą listą i będzie rósł dalej, więc próg trzeba było przestać
 * naciskać — a nie podnosić. Granica cięcia nie jest przypadkowa: to ta sama, którą repo ma
 * już w `src/adapters/` (wyjścia do świata) — dokąd wysyłamy i pod jaki adres pukamy, w jednym
 * miejscu, osobno od pokręteł sterujących samym potokiem.
 *
 * Wartości wracają do params.ts SPREADEM W TYM SAMYM MIEJSCU, w którym stały wcześniej,
 * bo kolejność kluczy wyznacza kolejność w `.env.example`, `config.json` i w tabeli README.
 * Przestawienie ich byłoby wielkim diffem w plikach generowanych i zerową zmianą znaczenia.
 */
import { optInt, optText, text } from "./param.js";

export const OUTPUT_PARAMS = {
  // --- digest ---
  TELEGRAM_BOT_TOKEN: optText({
    group: "digest", cls: "secret", summary: "token bota; brak = digest Telegramem wyłączony",
  }),
  TELEGRAM_CHAT_ID: optText({
    group: "digest", cls: "setting", summary: "dokąd bot wysyła digest",
  }),
  DIGEST_CHILD_AGE: optInt({
    group: "digest", cls: "setting", min: 0, example: "5",
    summary: "wiek dziecka; brak = digest bez filtra wiekowego",
  }),
  RESEND_API_KEY: optText({
    group: "digest", cls: "secret", summary: "klucz Resend — e-mailowy wariant digestu, w zapasie",
  }),
  DIGEST_TO: optText({
    group: "digest", cls: "setting", summary: "adresat e-maila; brak = wariant e-mail wyłączony",
  }),
  DIGEST_FROM: text({
    group: "digest", cls: "setting", def: "events-pl <onboarding@resend.dev>",
    summary: "nadawca e-maila",
  }),

  // --- endpoints ---
  OPENROUTER_URL: text({
    group: "endpoints", cls: "endpoint", def: "https://openrouter.ai/api/v1/chat/completions",
    summary: "adres chat completions",
    doc: ["Adresy poniżej mają sensowne wartości domyślne i normalnie nie trzeba ich ustawiać.",
      "Istnieją po to, żeby dało się wpiąć proxy/gateway albo mock w testach integracyjnych."],
  }),
  SERPER_URL: text({
    group: "endpoints", cls: "endpoint", def: "https://google.serper.dev/search",
    summary: "adres wyszukiwarki Serper",
  }),
  BRAVE_URL: text({
    group: "endpoints", cls: "endpoint", def: "https://api.search.brave.com/res/v1/web/search",
    summary: "adres wyszukiwarki Brave",
  }),
  GOOGLE_URL: text({
    group: "endpoints", cls: "endpoint", def: "https://www.googleapis.com/customsearch/v1",
    summary: "adres Google Programmable Search",
  }),
  OVERPASS_URL: text({
    group: "endpoints", cls: "endpoint", def: "https://overpass-api.de/api/interpreter",
    summary: "adres Overpass (OSM) — do własnej instancji, gdy publiczna dławi",
  }),
};
