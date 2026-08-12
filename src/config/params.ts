/**
 * REJESTR PARAMETRÓW — jedyne miejsce, w którym potok czyta środowisko.
 *
 * Każda zmienna ma tu dokładnie jeden wpis: nazwę (z klucza), typ, wartość domyślną i prozę
 * mówiącą PO CO ona jest. Z tego samego wpisu bierze się `.env.example` ORAZ tabela w README
 * (`npm run config:docs`), więc dokumentacja nie może się rozjechać z kodem — pilnuje tego test.
 *
 * Wcześniej te 55 zmiennych mieszkało w 52 miejscach naraz, każde z własną wartością domyślną
 * wpisaną w wyrażenie (`Number(process.env["EXTRACT_MAX_TOKENS"] ?? 12_000)`) i własnym,
 * lekko innym parserem — ten sam pomocnik `num()` był skopiowany do trzech plików, a w
 * czwartym miał inne zasady walidacji. Na pytanie „jakie są pokrętła i co jest ustawione"
 * nie odpowiadało nic.
 *
 * DOPISUJĄC PARAMETR: wpis tutaj, potem `npm run config:docs`. Nic więcej — plik przykładowy
 * i README nadążą same.
 *
 * DWA POLA OPISU, bo odpowiadają na dwa różne pytania: `summary` (wymagane, jedna linia) mówi
 * CO parametr robi i trafia do obu dokumentów; `doc` (opcjonalne) mówi DLACZEGO akurat tak
 * i zostaje w .env.example, bo tam czyta je ten, kto właśnie ma coś ustawić.
 *
 * Klasy (`cls`) nie są ozdobą: `tuning` to progi sterujące zachowaniem potoku i to one pojadą
 * kiedyś do wersjonowanego `config.json`, żeby zmiana progu zostawiała ślad w historii repo.
 * `secret` nigdy nie może tam trafić.
 */
import { csv, defineParams, num, offWhenZero, oneOf, optInt, optPosNum, optText, posNum, text } from "./param.js";
import type { Param } from "./param.js";

export const P = defineParams({
  // --- llm ---
  OPENROUTER_API_KEY: optText({
    group: "llm", cls: "secret", fill: true, example: "sk-or-...",
    summary: "klucz do OpenRoutera — bez niego nie ruszy ani ekstrakcja, ani discovery",
  }),

  // --- search ---
  SERPER_API_KEY: optText({
    group: "search", cls: "secret", fill: true,
    summary: "klucz Serpera — bez niego discovery i naprawa martwych URL-i nie działają",
    doc: [
      "Domyślnie Serper (serper.dev): wyniki Google bez Google Programmable Search, które od",
      "lipca 2026 nie przyjmuje nowych klientów. Darmowe 2500 zapytań na start.",
      "Klucz idzie nagłówkiem X-API-KEY, nigdy w URL-u — discover-runs.json trafia do repo.",
    ],
  }),
  SEARCH_PROVIDER: oneOf({
    group: "search", cls: "setting", values: ["serper", "google", "brave"], def: "serper",
    summary: "serper (domyślnie) | google | brave",
  }),
  GOOGLE_API_KEY: optText({
    group: "search", cls: "secret",
    summary: "tylko dla SEARCH_PROVIDER=google (konta sprzed 07.2026)",
  }),
  GOOGLE_CSE_CX: optText({
    group: "search", cls: "setting",
    summary: "id silnika; MUSI mieć włączone „Search the entire web”",
  }),
  BRAVE_API_KEY: optText({
    group: "search", cls: "secret",
    summary: "tylko dla SEARCH_PROVIDER=brave (2000 zapytań/mies. gratis)",
  }),
  DISCOVER_MAX_SEARCHES: num({
    group: "search", cls: "tuning", def: 300, min: 0,
    summary: "sufit zapytań do wyszukiwarki na jeden przebieg discovery",
    doc: [
      "bezpiecznik limitu: po tylu zapytaniach przebieg przestaje odpytywać wyszukiwarkę",
      "(~10 zapytań na gminę: Poznań +15 km to ~130, Warszawa z dzielnicami 200+; darmowa pula",
      "Serpera to 2500, czyli kilkanaście pełnych przebiegów; pominięte lądują w raporcie jako skipped)",
    ],
  }),

  // --- models ---
  MODEL_EXTRACT: text({
    group: "models", cls: "setting", def: "anthropic/claude-haiku-4.5",
    summary: "model codziennej ekstrakcji — musi umieć obrazy i JSON po polsku",
  }),
  MODEL_DISCOVER: text({
    group: "models", cls: "setting", def: "anthropic/claude-sonnet-4.6",
    summary: "model miesięcznego discovery — mocniejszy, bo ocenia trafienia wyszukiwarki",
  }),

  // --- structured ---
  STRUCTURED_OUTPUTS: offWhenZero({
    group: "structured", cls: "setting", example: "0",
    summary: "`0` wyłącza wymuszony JSON Schema na odpowiedzi modelu",
    doc: [
      "Wymusza na modelu kształt z src/types/event-schema.ts zamiast prosić o niego w prompcie.",
      "Obsługa zależy nie od samego modelu, tylko od ENDPOINTU: ten sam model OpenRouter serwuje",
      "z kilku źródeł (Anthropic, Azure, Bedrock…) i tylko część z nich przyjmuje response_format.",
      "Przy schemacie dokładamy `provider.require_parameters`, żeby routing omijał te bez obsługi —",
      "inaczej dostaje się losowe 400 wyglądające na błąd schematu.",
      "Zanim zmienisz, sprawdź jednym płatnym wywołaniem: npm run check:structured",
      "Gdyby model jednak odbił schemat, przebieg się nie wywraca — leci dalej bez niego.",
      "",
      "UWAGA NA KOSZT. Schemat leci w KAŻDYM requeście i nie jest darmowy. Pomiar sondą",
      "2026-07-28, ta sama treść i ten sam prompt, Haiku 4.5:",
      "  bez schematu:  937 tok wejścia + 286 wyjścia",
      "  ze schematem: 3222 tok wejścia + 173 wyjścia   (~3,4× wejście)",
      "Narzut jest STAŁY (~2300 tok), więc przy realnej ekstrakcji (9-14k tok wejścia) to ~+20%,",
      "rząd +$3/mies. przy 46 źródłach dziennie.",
      "",
      "Od 2026-08-01 WŁĄCZONE DOMYŚLNIE — narzut kupuje poprawność, nie wygodę. Bez schematu model",
      "przepisuje typografię strony i wypuszcza `\"title\": \"Spacer „Okrąglak\" z ...\"` (polski",
      "cudzysłów otwierający, ASCII zamykający), co urywa string JSON-a w środku wartości.",
      "Pomiar na estrada.poznan.pl: 8 wydarzeń bez schematu, 25 z nim.",
      "",
      "Odkomentuj, żeby WYŁĄCZYĆ:",
    ],
  }),
  STRUCTURED_IGNORE_PROVIDERS: csv({
    group: "structured", cls: "setting", def: ["azure"],
    summary: "dostawcy OpenRoutera pomijani na ścieżce ze schematem (po przecinku)",
    doc: [
      "Dostawcy pomijani przy schemacie (slugi OpenRoutera, po przecinku). Domyślnie `azure`:",
      'deklaruje obsługę response_format, ale odbija ją na poziomie konta („structured_outputs',
      'not supported in your workspace"), czego require_parameters nie wyłapie. Wyczyść wartość,',
      "jeśli Twój workspace Azure ma to uprawnienie.",
    ],
  }),

  // --- fb ---
  BRIGHTDATA_API_KEY: optText({
    group: "fb", cls: "secret",
    summary: "klucz Bright Data — bez niego cały kanał FB jest pomijany",
    doc: [
      "Bez klucza FB jest pomijany (tryb zero-cost), reszta pipeline działa normalnie.",
      "Rozliczenie per-rekord → brightdata-usage.jsonl. Bezpiecznik kosztów: BD_MAX_FB_EVENTS.",
    ],
  }),
  BD_MAX_FB_EVENTS: num({
    group: "fb", cls: "tuning", def: 40, min: 0,
    summary: "sufit rozwijanych linków do wydarzeń FB na jeden przebieg",
  }),
  BD_DATASET_FB_EVENTS: text({
    group: "fb", cls: "setting", def: "gd_m14sd0to1jz48ppm51",
    summary: "id scrapera wydarzeń FB (nadpisanie na wypadek zmian po stronie BD)",
  }),
  BD_DATASET_FB_GROUP_POSTS: text({
    group: "fb", cls: "setting", def: "gd_lz11l67o2cb3r0lkj3",
    summary: "id scrapera postów z grup FB",
  }),
  BD_POLL_MS: posNum({
    group: "fb", cls: "tuning", def: 10_000,
    summary: "co ile odpytywać Bright Data o gotowość migawki",
  }),
  BD_TIMEOUT_MS: posNum({
    group: "fb", cls: "tuning", def: 480_000,
    summary: "po tylu ms migawka jest porzucana i anulowana (awaria 2026-08-10)",
  }),

  FB_GROUP_BLOCKED_LIMIT: posNum({
    group: "fb", cls: "tuning", def: 3,
    summary: "po tylu płatnych wierszach błędu z rzędu grupa jest pomijana",
    doc: [
      "Grupa prywatna/usunięta oddaje przy include_errors=true jeden PŁATNY wiersz błędu zamiast",
      "postów — codziennie, w nieskończoność. Po tylu takich pobraniach z rzędu daily ją pomija",
      "(status skipped-blocked), a co RECHECK_DAYS puszcza jedną sondę, bo grupy bywają otwierane",
      "z powrotem i bez sondy nie miałby tego kto zauważyć.",
    ],
  }),
  FB_GROUP_BLOCKED_RECHECK_DAYS: posNum({
    group: "fb", cls: "tuning", def: 14,
    summary: "co tyle dni jedna sonda do pomijanej grupy — jedyna droga powrotna",
  }),

  FB_GROUP_LIMIT_MAX: posNum({
    group: "fb", cls: "tuning", def: 50,
    summary: "sufit rekordów na grupę; regulator może zejść niżej, nigdy wyżej",
    doc: [
      "Regulator limit_per_input per grupa. Zamiast jednej stałej dla wszystkich, limit liczy się",
      "z POKRYCIA: czy to, co wróciło, sięgnęło wstecz aż do poprzedniego pobrania. Sufit jest",
      "domyślnie równy dotychczasowej stałej (50), więc regulator może wydatek tylko zmniejszyć —",
      "pętla sama podnosząca limit u dostawcy per-rekord to dokładnie awaria z 2026-08-10.",
    ],
  }),
  FB_GROUP_LIMIT_MIN: posNum({
    group: "fb", cls: "tuning", def: 10, summary: "podłoga rekordów na grupę",
  }),
  FB_GROUP_LIMIT_MARGIN: posNum({
    group: "fb", cls: "tuning", def: 0.2,
    summary: "zapas ponad pokrycie przerwy między pobraniami (0.2 = 20%)",
  }),

  FB_MAX_USD_PER_EVENT: optPosNum({
    group: "fb", cls: "tuning", example: "0.10",
    summary: "próg $ za wydarzenie spoza sieci; brak = mechanizm w ogóle nie działa",
    doc: [
      "Próg opłacalności grup FB. Mierzy $ za wydarzenie, którego NIE dało żadne źródło spoza FB",
      "(`novel`) — bo brutto plon grupy w większości powiela to, co i tak stoi na stronach.",
      "BEZ TEJ ZMIENNEJ MECHANIZM NIE DZIAŁA: wycena wydarzenia jest decyzją właściciela projektu,",
      "nie stałą w kodzie. Źródło powyżej progu jest wyciszane CZASOWO (skipped-costly) i wraca samo.",
      "Podstawa werdyktu jest widoczna w job summary (tabela „Wartość kanału FB”) i w runs.json.",
    ],
  }),
  FB_YIELD_MIN_RUNS: posNum({
    group: "fb", cls: "tuning", def: 5,
    summary: "minimum realnych pobrań, zanim próg zapadnie",
  }),
  FB_MUTE_DAYS: posNum({
    group: "fb", cls: "tuning", def: 30,
    summary: "na ile dni wycisza, zanim źródło wróci do pomiaru",
  }),
  FB_MIN_SOURCES_PER_TOWN: num({
    group: "fb", cls: "tuning", def: 1, min: 0,
    summary: "ile grup FB zostaje w gminie mimo progu; 0 wyłącza podłogę",
    doc: [
      "Podłoga obsady gminy. Sam próg jest stronniczy geograficznie i to nie przez jakość źródeł,",
      "tylko przez arytmetykę: ten sam koszt rekordów dzieli się w gminie wiejskiej przez kilka",
      "wydarzeń, a w Poznaniu przez pięćdziesiąt (pomiar 2026-08-12: najtańsze $0.0023 to wyłącznie",
      "Poznań, najdroższe $0.09 — wyłącznie Puszczykowo/Luboń/Dopiewo). Podłoga gwarantuje, że",
      "gmina nie straci CAŁEJ obecności na FB przez sam rachunek; ratowane jest zawsze najtańsze",
      "z pozostałych źródeł gminy (werdykt `town-floor`). 0 = wyłącz podłogę.",
    ],
  }),

  // --- pipeline ---
  EXTRACT_MAX_TOKENS: posNum({
    group: "pipeline", cls: "tuning", def: 12_000,
    summary: "sufit tokenów odpowiedzi przy ekstrakcji wydarzeń",
    doc: [
      "Sufit tokenów wyjścia jednego wywołania. Obciętą odpowiedź ratuje json-salvage,",
      "ale ratunek gubi ogon listy — strona z pełnym kalendarium traci najdalsze terminy.",
    ],
  }),
  DISCOVER_MAX_TOKENS: posNum({
    group: "pipeline", cls: "tuning", def: 12_000,
    summary: "sufit tokenów odpowiedzi przy ocenie trafień wyszukiwarki",
  }),
  BLOCK_MAX_CALLS: num({
    group: "pipeline", cls: "tuning", def: 80, min: 0,
    summary: "sufit wywołań LLM na blokowanie źródeł w przebiegu (0 = nie wołaj)",
  }),
  ENTRYPOINT_LLM: oneOf({
    group: "pipeline", cls: "tuning", values: ["always", "ambiguous", "never"], def: "always",
    summary: "kiedy pytać model o punkt wejścia gminy: always | ambiguous | never",
    doc: [
      "`ambiguous` pyta tylko wtedy, gdy sam pomiar nie wskazał wyraźnego zwycięzcy, `never`",
      "zostawia decyzję pomiarowi i nie kosztuje ani jednego wywołania LLM.",
    ],
  }),

  // --- archive ---
  SUPABASE_URL: optText({
    group: "archive", cls: "setting", fill: true, example: "https://xxxxxxxx.supabase.co",
    summary: "adres projektu Supabase; brak = archiwum wyłączone, reszta działa",
    doc: [
      "Settings → API Keys → **Secret key** (sb_secret_…), NIE Publishable (sb_publishable_…).",
      "Supabase przemianował klucze: Secret = dawny service_role, Publishable = dawny anon.",
      "Ten klucz omija RLS: tylko backend/Actions/lokalny most, NIGDY panel ani frontend.",
    ],
  }),
  SUPABASE_SECRET_KEY: optText({
    group: "archive", cls: "secret", fill: true,
    summary: "klucz Secret (sb_secret_…), NIE Publishable — omija RLS",
  }),
  SUPABASE_SERVICE_ROLE_KEY: optText({
    group: "archive", cls: "secret",
    summary: "dawna nazwa tego samego klucza (projekty z JWT eyJ…)",
  }),
  SUPABASE_BUCKET: text({
    group: "archive", cls: "setting", def: "archive", summary: "bucket archiwum treści",
  }),
  ARCHIVE_RETENTION_DAYS: posNum({
    group: "archive", cls: "tuning", def: 90,
    summary: "po tylu dniach obiekty archiwum idą do skasowania",
  }),
  ARCHIVE_PORT: posNum({
    group: "archive", cls: "setting", def: 8787,
    summary: "port lokalnego mostu panelu (npm run panel-server)",
  }),

  // --- costs ---
  COST_MONTHLY_BUDGET_USD: num({
    group: "costs", cls: "tuning", def: 15, min: 0,
    summary: "linia odniesienia w panelu (nie limit twardy)",
    doc: [
      "LLM podaje kwotę sam (OpenRouter zwraca `cost` przy każdym wywołaniu) — reszta jest",
      "liczona jako wolumen × stawka i tak też oznaczona w panelu (`~`). Zmiana stawki nie",
      "przelicza starych wpisów: księga zapisuje stawkę obowiązującą w momencie przebiegu.",
    ],
  }),
  COST_RETENTION_DAYS: posNum({
    group: "costs", cls: "tuning", def: 90,
    summary: "ile dni kwot trzyma księga (runs.json trzyma 7 dni szczegółów)",
  }),
  BD_COST_PER_RECORD: num({
    group: "costs", cls: "tuning", def: 0.0015, min: 0,
    summary: "stawka Bright Data za rekord (potwierdź w panelu BD)",
  }),
  SEARCH_COST_PER_QUERY: num({
    group: "costs", cls: "tuning", def: 0.001, min: 0,
    summary: "stawka za zapytanie: Serper ~0.001, Google 0.005, Brave 0",
  }),
  SUPABASE_COST_PER_GB_MONTH: num({
    group: "costs", cls: "tuning", def: 0, min: 0,
    summary: "stawka za GB archiwum na miesiąc (darmowy tier ~1 GB)",
  }),
  SCRAPE_COST_PER_FETCH: num({
    group: "costs", cls: "tuning", def: 0, min: 0,
    summary: "stawka za pobranie strony (GH Actions dla repo publicznego: 0)",
  }),

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

  // --- ambient: nie renderują się do .env.example, bo nie my je ustawiamy ---
  GITHUB_ACTIONS: optText({
    group: "ambient", cls: "ambient", summary: "ustawia runner — po tym poznajemy, że jesteśmy w Actions",
  }),
  GITHUB_STEP_SUMMARY: optText({
    group: "ambient", cls: "ambient", summary: "ścieżka pliku job summary; poza Actions nie istnieje",
  }),
});

/** Wszystkie parametry w kolejności deklaracji — do renderowania i do zrzutów. */
export const ALL_PARAMS: readonly Param<unknown>[] = Object.values(P);
