/** state.json — cache między przebiegami (hashe, geo, ekstrakcje). */

import type { EventItem } from "./event.js";
import type { GeoVerdict } from "./geo.js";

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
  /** cache geokodera per "venue|town" — cały werdykt, bo „gdzie to jest" jest tak samo drogie */
  geo: Record<string, GeoVerdict>;
  /**
   * Prostokąt regionu, w którym zadano pytania siedzące w `geo`. Zmiana zasięgu projektu
   * unieważnia cache (patrz `setGeoRegion` w adapters/nominatim.ts) — bez stempla stare
   * odpowiedzi z innego obszaru zostałyby tu na zawsze, bo klucz „venue|town" się nie zmienia.
   */
  geoRegion?: string;
  /**
   * Obce serwisy odwiedzane followupami: ile przebiegów Z RZĘDU nie dały ani jednego
   * OPUBLIKOWANEGO wydarzenia. Klucz to host bez „www". Wpis rośnie, zeruje się przy
   * pierwszym opublikowanym wydarzeniu i wygasa — patrz extract/followup-hosts.ts.
   */
  followupHosts?: Record<string, { runs: number; since: string; lastTry: string }>;
  /** cache ekstrakcji per source.id / URL followupa */
  extractions?: Record<string, CachedExtraction>;
  /**
   * Szablon paginacji ODGADNIĘTY sondą — dla listingów, których pager nie niesie adresów
   * (numer dokłada JS). `url` z `{page}` w miejscu numeru; `null` znaczy „sondowaliśmy
   * i żaden kandydat nie oddał drugiej strony", i to też trzeba pamiętać: bez tego pięć
   * pobrań u cudzego serwisu wracałoby w każdym przebiegu.
   *
   * Wpis wygasa po `PAGER_PROBE_RECHECK_DAYS` liczonych przy ODCZYCIE, jak `sameAsPage`:
   * serwis przebudowany w międzyczasie ma się odnaleźć sam, bez człowieka w pętli.
   */
  pagerTemplate?: Record<string, { url: string | null; at: string }>;
  /**
   * Followupy ostatnio widziane w danym źródle. Followupy pochodzą z ekstrakcji strony,
   * więc przy niezmienionej stronie nie znamy ich z bieżącego przebiegu — a plakat potrafi
   * się zmienić pod tym samym URL-em przy nietkniętym tekście strony.
   */
  followupsBySource?: Record<string, string[]>;
  /**
   * Autorzy postów FB, których plakatów nie czytamy — klucz to sha256(sól + id), NIGDY samo id.
   * Repo jest publiczne, a autor postu w wiejskiej grupie to osoba prywatna; do pytania
   * „czy ten sam ktoś wrzucił trzy razy śmieć" wystarczy licznik. Patrz extract/fb-author-mute.ts.
   */
  fbPosterAuthors?: Record<string, { empty: number; at: string; mutedUntil?: string }>;
  /**
   * Followupy, które okazały się TĄ SAMĄ treścią co strona źródła: source.id → urlKey → dzień
   * potwierdzenia (YYYY-MM-DD). Bez tej pamięci taki adres zjadał slot w kolejce w każdym
   * przebiegu — wykryć go da się dopiero po pobraniu, a wtedy limit jest już wydany.
   *
   * Wpis wygasa po `FOLLOWUP_SAME_PAGE_RECHECK_DAYS` liczonych przy ODCZYCIE, nie zapisanych
   * jako data końcowa: zmiana progu ma działać od razu, a nie od następnego potwierdzenia.
   * Patrz `pipeline/extract/followup-queue.ts`.
   */
  sameAsPage?: Record<string, Record<string, string>>;
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
  /**
   * Grupy FB wyciszone progiem opłacalności (`FB_MAX_USD_PER_EVENT`). Wpis wygasa sam
   * w dniu `until` — patrz `pipeline/extract/fb-cost-mute.ts`.
   */
  fbMuted?: Record<string, {
    since: string;
    /** YYYY-MM-DD, od którego źródło wraca do pomiaru */
    until: string;
    /** podstawa werdyktu, żeby dało się go sprawdzić bez odtwarzania okna */
    novel: number;
    costUsd: number;
    /** brak = źródło nie dało ANI JEDNEGO wydarzenia spoza sieci */
    usdPerNovel?: number;
  }>;
  /**
   * Regulator `limit_per_input` per grupa: co zapisać na następne pobranie i kiedy zmierzono.
   * Patrz `pipeline/extract/fb-group-limit.ts`.
   */
  fbGroupRate?: Record<string, {
    /** YYYY-MM-DD ostatniego udanego pobrania */
    at: string;
    /** limit na NASTĘPNE pobranie, przy jednodniowej przerwie */
    next: number;
    /** pomiar tempa; `null` = okno było zerowe. Nie steruje niczym, zostaje jako ślad */
    postsPerDay: number | null;
    spanDays: number;
  }>;
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
