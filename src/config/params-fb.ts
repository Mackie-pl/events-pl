/**
 * Rejestr parametrów, część trzecia: KANAŁ FACEBOOK — klucz i datasety Bright Data,
 * sterowanie wydatkiem i bezpieczniki grup.
 *
 * Wydzielone z params.ts z tego samego powodu i tym samym cięciem co `params-outputs.ts`:
 * rejestr rośnie, a progu 350 linii nie podnosimy. Granica jest tu naturalna — to jedyna
 * grupa parametrów opisująca JEDEN płatny kanał, i jedyna, w której pomyłka kosztuje
 * pieniądze u dostawcy rozliczającego się per-rekord (awaria 2026-08-10, $8 za noc).
 *
 * Wartości wracają do params.ts SPREADEM W TYM SAMYM MIEJSCU, w którym stały wcześniej,
 * bo kolejność kluczy wyznacza kolejność w `.env.example`, `config.json` i w tabeli README.
 */
import { num, optPosNum, optText, posNum, text } from "./param.js";

export const FB_PARAMS = {
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
  BD_DATASET_FB_PAGE_POSTS: optText({
    group: "fb", cls: "setting",
    summary: "id scrapera postów z FANPAGE'ÓW — bez niego sonda fanpage'ów nie ruszy",
    doc: [
      "Bez domyślnej CELOWO: zgadnięte id u dostawcy per-rekord to albo błąd triggera, albo —",
      "gorzej — płatny scrape czegoś innego. Id z panelu Bright Data (Facebook → posty strony).",
      "Czyta je WYŁĄCZNIE `npm run probe-fb-pages`; daily pomija `fetch:\"fb\"` tak czy owak.",
    ],
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
    group: "fb", cls: "tuning", def: 5, summary: "podłoga rekordów na grupę",
    doc: [
      "Podłoga jest po to, żeby grupa cicha DZIŚ dała się jutro zmierzyć — regulator czyta tempo",
      "wyłącznie z tego, co wróciło, więc limit zjechany do zera zamrażałby go na zawsze.",
      "Pomiar 2026-08-12: podłoga wiąże 14 z 20 grup, wyliczenia sięgają tam 1–4 rekordów,",
      "czyli 10 → 5 to ~$2.4/mies., a 5 → 3 dalsze ~$0.5. Te $0.5 nie są warte ryzyka:",
      "rekord bez treści liczy się w fb-group-blocked jako wiersz błędu, więc przy podłodze 3",
      "grupa o niskim udziale treści (Luboń: 22%) ma ~10% szans na trzy pobrania bez ani",
      "jednego postu z rzędu i fałszywe wyłączenie. Przy 5 to ~2%.",
    ],
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

  PROBE_FB_PAGE_LIMIT: posNum({
    group: "fb", cls: "tuning", def: 20,
    summary: "limit_per_input na jeden fanpage w sondzie `probe-fb-pages`",
    doc: [
      "Niżej niż sufit grup (50): fanpage publikuje rzadziej niż tablica ogłoszeń. Przy werdykcie",
      "„nic nie dało” sprawdź w tabeli `atLimit` — wyczerpany limit znaczy plon ucięty, nie zmierzony.",
    ],
  }),
  // sufit CAŁEJ sondy, liczony przed pierwszym triggerem i sprawdzany po każdym pobraniu —
  // pętla po źródłach u dostawcy per-rekord to kształt awarii z 2026-08-10 (patrz fb-page.ts)
  PROBE_FB_MAX_RECORDS: posNum({
    group: "fb", cls: "tuning", def: 300,
    summary: "twardy sufit rekordów na CAŁĄ sondę fanpage'ów (~$0.45 przy $0.0015/rekord)",
  }),

  FB_PROBATION_SHARE: num({
    group: "fb", cls: "tuning", def: 0.15, min: 0,
    summary: "część budżetu FB na POMIAR źródeł jeszcze niezmierzonych (0 = nowe nigdy nie wejdą)",
    doc: [
      "Ranking wartości potrafi ustawić tylko źródła, które już coś dały — nowe z discovery nie",
      "mają jeszcze ceny, więc bez osobnego pasa nigdy by jej nie zdobyły i kanał zamarłby na",
      "dzisiejszym składzie. Ten ułamek budżetu jest zarezerwowany na ich pierwsze pobrania,",
      "najstarsze niezmierzone najpierw. 0 wyłącza pas: nic nowego nie wejdzie do kanału.",
    ],
  }),
} as const;
