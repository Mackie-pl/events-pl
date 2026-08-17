/** Raport przebiegu daily (runs.json). */

import type { ConfigSnapshot } from "../config/snapshot.js";
import type { CostEntry } from "./cost.js";
import type { FetchStrategy } from "./source.js";
import type { BdUsage, LlmUsage, TaskUsage } from "./usage.js";

// ---------------- observability / run reporting ----------------

/**
 * `skipped-dead` i `skipped-inactive` to dwie różne diagnozy i dlatego są dwoma statusami:
 * pierwszy znaczy „drabina udowodniła, że adresu nie ma", drugi „discovery przestało go
 * znajdować i nic z niego nie plonuje". Pierwszy naprawia re-discovery, drugi sam wraca,
 * gdy wyszukiwarka znowu pokaże adres.
 */
export type SourceStatus =
  | "ok" | "unchanged" | "error" | "skipped-fb" | "skipped-dead" | "skipped-inactive"
  /** grupa FB, która w kolejnych pobraniach oddawała wyłącznie wiersz błędu (prywatna/usunięta) */
  | "skipped-blocked"
  /** źródło FB poza linią budżetu kanału — wyciszone czasowo, wraca samo */
  | "skipped-costly"
  | "empty";

/**
 * Rachunek wartości jednego źródła FB w oknie `runs.json` — podstawa progu opłacalności.
 *
 * Trafia do raportu przebiegu także dla źródeł, których próg nie ruszył, i to jest cały
 * sens: werdykt „wyciszone" bez widocznej podstawy jest nie do sprawdzenia, a `verdict`
 * odróżnia „przeszło próg" od „za mało pobrań, żeby sądzić" i od „progu w ogóle nie ma".
 */
export interface FbValueRow {
  id: string;
  /** realne pobrania w oknie (bez `skipped-*`) — mianownik minimum z `FB_YIELD_MIN_RUNS` */
  fetchedRuns: number;
  /** różne wydarzenia, jakie źródło dało w oknie */
  distinct: number;
  /** z tego: takie, których nie dało ŻADNE źródło spoza FB */
  novel: number;
  /** takie, których nie dało żadne inne źródło w ogóle (także inna grupa FB) */
  exclusive: number;
  costUsd: number;
  /** brak = `novel === 0`, czyli koszt za nic nowego (traktowane jak najgorsza możliwa cena) */
  usdPerNovel?: number;
  /** pozycja w kolejce wartości; brak = źródło jeszcze bez wiarygodnej ceny */
  rank?: number;
  /**
   * Koszt JEDNEGO pobrania — jednostka, w której regulator wydaje budżet. Dla źródeł nigdy
   * niepobieranych to SZACUNEK z sufitu limitu, nie pomiar: bez tego rozróżnienia „$0.0000"
   * w raporcie znaczyłoby raz „za darmo", a raz „nie wiemy" (patrz fb-cost-mute.ts).
   */
  usdPerFetch?: number;
  /** ile budżetu dziennego zjada wszystko do tej pozycji włącznie — czyni linię cięcia sprawdzalną */
  cumulativeUsd?: number;
  /**
   * `town-floor` = poza linią budżetu, ale zostaje, bo gmina straciłaby całą obecność na FB.
   * Osobno od `keep`, bo to nie jest ta sama wiadomość: źródło NIE mieści się w budżecie
   * i warto o tym wiedzieć, tylko cena wycięcia gminy z serwisu jest wyższa niż cena rekordów.
   * `probation` = jeszcze bez ceny, pobierane z pasa pomiarowego, żeby ją zdobyć.
   * `over-ceiling` = ponad twardym `FB_MAX_USD_PER_EVENT`, niezależnie od budżetu.
   */
  verdict:
    | "keep" | "muted" | "town-floor" | "too-few-runs" | "no-threshold"
    | "probation" | "over-ceiling";
}

/**
 * Rytm publikacji grupy FB, zmierzony na tym, co Bright Data właśnie oddało.
 *
 * Po co osobne pole, skoro `bd.records` już jest: rekord to jednostka ROZLICZENIA, a nie
 * miara treści. Grupa prywatna oddaje jeden płatny wiersz błędu i wygląda w rachunku tak
 * samo jak grupa z jednym postem; grupa gadatliwa i zamarła wyczerpują ten sam limit 50
 * i też są nieodróżnialne. Dopiero data najstarszego i najnowszego postu mówi, ile z tego
 * limitu poszło na jeden dzień — a to jest wejście do limitu liczonego per grupa.
 */
export interface FbGroupStats {
  /** rekordy oddane przez Bright Data — to jest jednostka rozliczenia */
  records: number;
  /** rekordy niosące treść postu */
  posts: number;
  /** rekordy bez treści = wiersze błędu z `include_errors` (grupa prywatna, usunięta, zmieniony adres) */
  errorRows: number;
  /** komunikat z pierwszego wiersza błędu, o ile scraper go podał */
  blockedWhy?: string;
  /** `limit_per_input` użyty przy tym pobraniu — bez niego `atLimit` nie da się odtworzyć */
  limit: number;
  /**
   * Limit wyczerpany. Wtedy `oldest` znaczy „dotąd sięgnęliśmy", a nie „tu zaczyna się grupa",
   * więc `postsPerDay` jest DOLNYM oszacowaniem tempa, nie pomiarem.
   */
  atLimit: boolean;
  /**
   * Data najnowszego postu w oknie. Odpowiada na pytanie, którego nie da się odczytać
   * z dokumentacji Bright Data: czy `limit_per_input` oddaje NAJNOWSZE posty, czy dowolne.
   * Wczorajsza data przy aktywnej grupie = najnowsze; data sprzed miesięcy = dowolne,
   * i wtedy całe liczenie tempa jest bez sensu.
   */
  newest?: string;
  oldest?: string;
  /** rozpiętość okna w dniach (z dokładnością do godzin) */
  spanDays?: number;
  /**
   * Posty na dobę; brak przy oknie zerowym albo gdy posty nie miały czytelnych dat.
   *
   * UWAGA przy `spanDays < 1`: okno krótsze od doby trafia zwykle w godziny szczytu i zawyża.
   * Sonda 2026-08-11 na `fb-group-allin-poznan` (5 rekordów, okno 09:22–13:03) dała 32.6/dobę,
   * podczas gdy to samo okno rozciągnięte na pełną dobę musi wyjść niżej — noc nic nie publikuje.
   * Limit liczony z takiej próbki byłby za wysoki, czyli droższy. Wiarygodne są okna ≥1 doby.
   */
  postsPerDay?: number;
}

/**
 * Rozliczenie ścieżki blokowej: ile bloków miała treść, ile wróciło z cache, ile poszło
 * do modelu. `fresh: 0` przy `total > 0` to odczyt w pełni darmowy.
 */
export interface BlockStats {
  total: number;
  cached: number;
  fresh: number;
}

export interface FollowupRun {
  url: string;
  kind: "poster" | "page";
  /**
   * unchanged = treść identyczna (304 albo ten sam hash), wydarzenia odtworzone z cache.
   * same-as-page = followup oddał DOKŁADNIE treść strony źródła, więc jego wydarzenia już są
   * w sumie i drugi odczyt byłby płaceniem za te same bajty (patrz process-source.ts).
   */
  outcome: "ok" | "error" | "unchanged" | "same-as-page";
  events: number;
  err?: string;
  /** np. „odpowiedź modelu ucięta na limicie" — followup ma własną, nie dzieli jej ze źródłem */
  note?: string;
  /** rozliczenie podziału na bloki; brak = followup szedł jednym wywołaniem na całość */
  blocks?: BlockStats;
}

/**
 * Tożsamość jednego wydarzenia w obrębie przebiegu — tyle, ile trzeba, by wskazać je
 * w events.json i pokazać w panelu, bez wkładania do runs.json drugiej kopii wszystkich pól.
 * Pełny rekord (sprzed redakcji PII) żyje w prywatnym archiwum z dnia ekstrakcji.
 *
 * Bez tego `SourceRun.events` był samą liczbą: „to źródło dało 10 wydarzeń" — których,
 * wiedziało tylko events.json, i to wyłącznie dla najnowszego przebiegu.
 */
export interface EventRef {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** URL konkretnego wydarzenia — dla followupa inny niż adres źródła */
  url: string;
  /**
   * id źródła, którego rekord wygrał dedupe (bywa nim to samo źródło — duplikat u siebie).
   * Brak = rekord przeszedł do events.json.
   */
  mergedInto?: string;
  /**
   * Klucz rekordu, którym ten ref OSTATECZNIE został — po dedupe i po zwinięciu serii.
   * Brak = ten ref niczym się nie stał poza sobą samym (klucz liczy się z `title` i `date`).
   *
   * Po co, skoro `title` i `date` już tu są: bo rytm rozwija się PRZED dedupe (patrz
   * pipeline/series.ts), więc jeden post o cotygodniowej zumbie wchodzi do przebiegu jako
   * kilkadziesiąt rekordów jednodniowych i tyleż refów. Bez tego pola raport plonu liczy
   * każdy termin jako osobne wydarzenie i wychodzi na to, że wiejska grupa dała 270 rzeczy,
   * których nikt inny nie ma — zmierzone 2026-08-13: `lubon-fb-group` miał 74 klucze z 5
   * postów (×14.8), a `dopiewo-tablica-ogloszen-fb` 272 z 20 (×13.6).
   *
   * Klucz idzie do KOŃCA łańcucha scaleń, nie o jeden krok. Kopia serii z drugiej grupy
   * przegrywa najpierw dedupe (na swoim dniu), a dopiero zwycięzca zwija się w rytm —
   * dwa kroki, po których 111 refów zumby z dwóch grup Lubonia wskazuje jeden rekord.
   */
  key?: string;
}

export interface SourceRun {
  id: string;
  name: string;
  town: string;
  url: string;
  fetch: FetchStrategy;
  status: SourceStatus;
  httpStatus?: number;
  kind?: "html" | "pdf" | "feed";
  /**
   * Wyjście maszynowe użyte zamiast skrobania HTML-a. Obecne = to źródło nie kosztowało
   * ani jednego wywołania modelu; `llm.calls === 0` przy `events > 0` jest tego dowodem
   * w costs.json. `fellBack` = feed nic nie dał i wróciliśmy na stronę + model.
   */
  structured?: {
    kind: "rss" | "wp-rest" | "tribe" | "ical" | "jsonld";
    url: string;
    /** rekordów w feedzie (przed odsiewem) */
    seen: number;
    /** wydarzeń po odsiewie */
    items: number;
    /** ile i dlaczego odpadło — bez tego „8 rekordów → 3 wydarzenia" jest zagadką */
    dropped?: { past?: number; noDate?: number; noTitle?: number };
    fellBack?: boolean;
  };
  /** długość pobranego tekstu */
  chars?: number;
  /** czy hash różnił się od stanu (zmiana treści) */
  changed?: boolean;
  /** wydarzenia zachowane z tego źródła (łącznie z followupami) */
  events: number;
  /**
   * Które to były wydarzenia — stan PRZED dedupe, więc suma po źródłach bywa większa
   * niż events.json. Brak pola = źródło nic nie dało (albo przebieg sprzed tej wersji).
   */
  produced?: EventRef[];
  followups: FollowupRun[];
  geo: { hits: number; misses: number };
  llm: LlmUsage;
  /** ten sam koszt w rozbiciu na zadania — bez tego plakat i tekst są nieodróżnialne */
  llmByTask?: TaskUsage;
  /** zużycie Bright Data przypisane temu źródłu (grupa FB); brak = nie dotykało BD */
  bd?: BdUsage;
  /** rytm publikacji grupy FB; brak = źródło nie jest grupą albo pobranie się nie udało */
  fbGroup?: FbGroupStats;
  ms: number;
  err?: string;
  /** np. "HTTP 403 → headless fallback ok" */
  note?: string;
  /** wydarzenia odtworzone z cache (bez wywołania LLM) */
  cached?: number;
  /** wydarzenia odrzucone z braku daty startu (atrakcje stałe) — brak = żadnego nie odrzucono */
  droppedInvalid?: number;
  /**
   * Wydarzenia odsiane jako minione. Rośnie wraz z cache'em bloków: wpis oceniony „dziś"
   * sprzed tygodnia oddaje terminy, które w międzyczasie minęły. Zero nie znaczy „nie było
   * czego odsiewać" — znaczy „nic nie wygasło od ostatniego czytania".
   */
  droppedPast?: number;
  /**
   * Wydarzenia odsiane jako repertuar (seans kina/teatru pod adresem `…/seances/…`).
   * Brak NIE znaczy „źródło nie ma kina" — znaczy, że reguła adresowa odcięła repertuar
   * wcześniej, przed pobraniem. Patrz src/pipeline/repertoire.ts.
   */
  droppedRepertoire?: number;
  /**
   * Podział SAMEJ STRONY ŹRÓDŁA. Brak = źródło szło starą drogą (jedno wywołanie na całość)
   * albo w ogóle nie dotknęło modelu. Followupy mają własne rozliczenie w `followups[].blocks`
   * — sumowanie ich tutaj zlałoby „strona bez zmian" z „podstrona bez zmian", a to dwie różne
   * diagnozy dla jałowego źródła.
   */
  blocks?: BlockStats;
  /** followupy sprawdzone mimo niezmienionej strony źródła */
  followupsRechecked?: number;
  /** ścieżki obiektów w prywatnym archiwum (raw/ + llm/); brak = archiwum wyłączone */
  archive?: string[];
}

export interface RunTotals extends LlmUsage {
  sources: number;
  ok: number;
  unchanged: number;
  errors: number;
  skippedFb: number;
  skippedDead: number;
  /** pominięte jako zdegradowane — brak trafień w discovery i zero plonu */
  skippedInactive: number;
  /** grupy FB pominięte jako niedostępne dla scrapera (seria wierszy błędu) */
  skippedBlocked: number;
  /** grupy FB pominięte jako zbyt drogie względem plonu spoza sieci */
  skippedCostly: number;
  empty: number;
  events: number;
  followupsTried: number;
  geoHits: number;
  geoMisses: number;
  /** wydarzenia odrzucone z braku daty startu — model mimo promptu zwraca atrakcje stałe */
  droppedInvalid: number;
  /** ile numerów komórkowych / e-maili usunięto przed publikacją (pii.ts) */
  redactedPhones: number;
  redactedEmails: number;
}

export interface RunReport {
  stage: "daily" | "digest";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: RunTotals;
  sources: SourceRun[];
  /** zużycie Bright Data w tym przebiegu (brak = wyłączone) */
  brightdata?: BdUsage;
  /** koszt przebiegu w rozbiciu na kategorie — to samo, co trafiło do costs.json */
  costs?: CostEntry[];
  /** wartość kanału FB w oknie i werdykt progu; brak = w oknie nie było źródeł FB */
  fbValue?: FbValueRow[];
  /**
   * Progi, którymi kierował się TEN przebieg. Brak = raport sprzed wprowadzenia migawki.
   * Bez tego liczby wyżej są nie do zinterpretowania po fakcie: „wyciszono cztery grupy"
   * znaczy co innego przy progu $0.10, a co innego przy $0.02, i nic w raporcie tego
   * nie odróżniało.
   */
  config?: ConfigSnapshot;
}
