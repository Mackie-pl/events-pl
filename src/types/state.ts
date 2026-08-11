/** state.json — cache między przebiegami (hashe, geo, ekstrakcje). */

import type { EventItem } from "./event.js";

/**
 * Zapamiętany wynik ekstrakcji dla konkretnej treści.
 * Klucz w `extractions`: source.id (strona źródła) albo URL (followup: PDF/podstrona/plakat).
 *
 * Bez cache'owania samych wydarzeń „niezmienione" znaczyło „zero wydarzeń" — źródło znikało
 * z events.json do czasu, aż jego strona się zmieni. Hash oszczędza wywołanie LLM,
 * a `events` utrzymuje wynik przy życiu.
 *
 * Uwaga: state.json jest w publicznym repo, więc trzymane tu wydarzenia są PO redakcji PII.
 * Pełna wersja (z kontaktami) żyje w prywatnym archiwum z dnia ekstrakcji.
 */
export interface CachedExtraction {
  /** sha256 treści, z której powstały te wydarzenia */
  hash: string;
  events: EventItem[];
  at: string;
  /** walidatory HTTP — pozwalają pominąć pobranie w całości (304) */
  etag?: string;
  lastModified?: string;
}

/**
 * Wynik ekstrakcji JEDNEGO bloku treści. Klucz w `blocks`: sha256 tekstu bloku.
 *
 * Cache po CAŁEJ stronie oszczędza tylko wtedy, gdy nie zmienił się ani jeden znak — a pomiar
 * na dwunastu dniach archiwum pokazał, że 86.9% treści stoi w miejscu, podczas gdy trafień było
 * 15%. Klucz po bloku łapie tę różnicę: wynik strony to SUMA po blokach, które dziś na niej
 * stoją, więc znikająca karta nie kosztuje nic (bloku nie ma w sumie), a dochodząca kosztuje
 * dokładnie siebie.
 *
 * Wpis jest wspólny dla wszystkich źródeł — ten sam blok na dwóch stronach czyta się raz.
 *
 * Uwaga: state.json jest w publicznym repo, więc `events` są PO redakcji PII (daily.ts).
 */
export interface CachedBlock {
  /** wydarzenia tak, jak zwrócił je model — BEZ odsiewu przeszłych (patrz niżej) */
  events: EventItem[];
  /** odnośniki wskazane przez model w tym bloku */
  followups: string[];
  /** kiedy blok trafił do modelu */
  at: string;
  /** ostatni dzień, w którym blok stał na stronie — po tym przycinamy cache */
  seen: string;
}

export interface PipelineState {
  /** legacy: sam hash bez wyniku. Zastąpione przez `extractions`, zostaje dla starych plików. */
  hashes: Record<string, string>;
  /**
   * Cache ekstrakcji per BLOK treści (sha256 → wynik). Wspólny dla źródeł.
   *
   * Trzyma wydarzenia NIEODSIANE z przeszłych, i to jest świadome: odsiew przeszłych robimy
   * przy odczycie, bo „wszystkie wydarzenia tego bloku już minęły" jest jedynym sygnałem,
   * że blok trzeba przeczytać ponownie (ta sama treść w nowym roku znaczy nową datę).
   * Gdyby cache trzymał już odsiane, ten sygnał byłby nie do odróżnienia od „blok bez wydarzeń".
   */
  blocks?: Record<string, CachedBlock>;
  /** cache geokodera per "venue|town" */
  geo: Record<string, { lat: number; lon: number } | null>;
  /** cache ekstrakcji per source.id / URL followupa */
  extractions?: Record<string, CachedExtraction>;
  /**
   * Followupy ostatnio widziane w danym źródle. Followupy pochodzą z ekstrakcji strony,
   * więc przy niezmienionej stronie nie znamy ich z bieżącego przebiegu — a plakat potrafi
   * się zmienić pod tym samym URL-em przy nietkniętym tekście strony.
   */
  followupsBySource?: Record<string, string[]>;
  /**
   * Linki facebook.com/events/… ostatnio wyłuskane z treści danego źródła — analogicznie
   * do followupsBySource: przy 304 nie mamy tekstu, a rozwiązane wydarzenia FB nie mogą
   * przez to znikać z serwisu.
   */
  fbUrlsBySource?: Record<string, string[]>;
  /**
   * Grupy FB, które oddały same wiersze błędu — licznik serii, per source.id.
   * Wpis znika przy pierwszym pobraniu z jakimkolwiek postem, więc obecność wpisu
   * znaczy „ostatnie N pobrań nic nie dało", a nie „kiedyś się nie udało".
   * Patrz `pipeline/extract/fb-group-blocked.ts`.
   */
  fbGroupBlocked?: Record<string, {
    /** ile kolejnych pobrań oddało wyłącznie wiersze błędu */
    runs: number;
    /** pierwsze takie pobranie (YYYY-MM-DD) */
    since: string;
    /** ostatnia PRÓBA pobrania — od niej liczy się sonda, nie od `since` */
    lastTry: string;
    /** komunikat scrapera z ostatniej próby */
    why?: string;
  }>;
}
