/** Rejestr źródeł: co pobieramy, skąd się wzięło i czy adres jeszcze żyje. */

export type FetchStrategy =
  | "plain"
  | "headless"
  | "pdf"
  | "api"
  | "fb" // fanpage/strona FB — poza zakresem daily (osobny dataset)
  | "fb_group" // otwarta grupa FB — posty przez Bright Data → ekstrakcja LLM
  | "fb_event" // pojedyncze wydarzenie FB — rozwiązywane zbiorczo przez Bright Data (link → EventItem)
  | "rss";

export type SourceType =
  | "city_portal"
  | "culture_center"
  | "library"
  | "sports"
  | "venue"
  | "fb_page"
  | "fb_group"
  | "rss"
  | "api"
  | "pdf_program";

/**
 * Werdykt drabiny osiągalności. Jeden bool („ok / nie ok") mieszał ze sobą przypadki
 * wymagające przeciwnych napraw: wygasły certyfikat i anty-bot to strony ŻYWE (wystarczy
 * inny schemat albo przeglądarka), a `dns-dead` to adres nieistniejący, którego nie naprawi
 * nic poza ponownym discovery.
 */
export type ReachOutcome =
  | "ok"
  | "redirected" // odpowiada, ale pod innym adresem niż pytany (schemat/www/przekierowanie)
  | "anti-bot" // 403/429 dla zwykłego fetcha, treść jest — trzeba przeglądarki
  | "cert" // TLS odrzucony (wygasły/niedopasowany certyfikat), http bywa sprawne
  | "http-error" // serwer żyje, zasób nie (404/500) — kandydat do naprawy przez search
  | "dns-dead" // domena nie rozwiązuje się — jedyne wyjście to re-discovery
  | "placeholder"; // 200, ale treść poniżej MIN_BODY_CHARS (parking/zaślepka)

/**
 * Adres, pod którym źródło faktycznie WYPISUJE wydarzenia — w odróżnieniu od `Source.url`,
 * które jest korzeniem serwisu. Wchodzenie codziennie przez stronę główną oznaczało
 * podawanie modelowi menu i newslettera zamiast listy.
 *
 * Lista, bo część serwisów rozdziela „wydarzenia" od „aktualności" (i jedno bez drugiego
 * gubi część imprez), choć w praktyce dominuje jeden wpis.
 */
export interface EntryPoint {
  /** adres listy; może zawierać `{page}` — ten sam placeholder co w Source.url */
  url: string;
  kind: "listing" | "feed" | "api";
  /** szablon adresu strony pojedynczego wydarzenia (np. "/wydarzenia/{slug}") */
  detailPattern?: string;
  /** ile linków pasowało do szablonu w chwili rozpoznania — dowód, nie deklaracja */
  detailCount?: number;
  paginated?: boolean;
  confidence: number;
  via: "heuristic" | "llm";
}

/**
 * Maszynowe wyjście źródła, potwierdzone POBRANIEM, nie samym istnieniem endpointu.
 *
 * Rozpoznanie na żywych stronach: The Events Calendar odpowiadał `{"total":0}`, Modern Events
 * Calendar `[]`, a WP REST z typem `event` oddawał wpisy bez daty (`acf: []`). Wszystkie trzy
 * przeszłyby test „endpoint zwraca 200" i wszystkie trzy są bezużyteczne — stąd `itemsSeen`
 * i `datesParsed` jako warunek zapisu, a nie jako ozdoba raportu.
 */
export interface SourceCapability {
  kind: "rss" | "wp-rest" | "tribe" | "ical" | "jsonld";
  url: string;
  /** ile rekordów faktycznie wróciło; 0 → zdolności nie zapisujemy */
  itemsSeen: number;
  /** ile z nich miało czytelną datę; 0 → zostaje jako ślad, ale nie nadaje się do ekstrakcji */
  datesParsed: number;
  checked: string;
}

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  /** korzeń serwisu — klucz dedupe w rejestrze i nośnik proweniencji */
  url: string;
  town: string;
  fetch: FetchStrategy;
  verified: boolean;
  notes?: string;
  discovered?: string;
  confidence?: number;
  /** data ostatniej weryfikacji URL (YYYY-MM-DD) — discover --verify */
  checked?: string;
  /** poprzednie, błędne adresy (historia napraw) */
  previous_urls?: string[];
  /** URL martwy i nienaprawialny — daily pomija (skipped-dead) do czasu naprawy */
  dead?: boolean;
  /** gdzie wchodzić po wydarzenia (etap 1 ustala, etap 2 będzie konsumował) */
  entrypoints?: EntryPoint[];
  /** co serwis oddaje maszynowo — sprawdzane raz przy discovery, nie codziennie */
  capabilities?: SourceCapability[];
  /** werdykt ostatniej drabiny osiągalności */
  reach?: ReachOutcome;
  /** skąd się tu wzięło: zapytanie → wynik wyszukiwarki → decyzja modelu → pierwszy fetch */
  provenance?: SourceProvenance;
}

/**
 * Wynik jednego żądania HTTP — „co odpowiedział serwer, gdy pytaliśmy go pierwszy raz".
 * Sam kod statusu nie wystarcza do diagnozy: 200 z 300 bajtami to zwykle strona-zaślepka,
 * a 200 pod innym adresem niż pytany oznacza przekierowanie (np. na stronę główną).
 */
export interface FetchProbe {
  at: string;
  /** adres, o który pytaliśmy */
  url: string;
  ok: boolean;
  httpStatus?: number;
  /** adres po przekierowaniach — obecny tylko, gdy różny od `url` */
  finalUrl?: string;
  contentType?: string;
  /** długość odpowiedzi w znakach */
  chars?: number;
  ms: number;
  err?: string;
}

/**
 * Pełna ścieżka trafienia źródła do rejestru. Odpowiada na „dlaczego ten adres jest na liście?"
 * bez sięgania do przebiegów: kopia ląduje w sources.json obok samego źródła, więc przeżywa
 * przycinanie discover-runs.json.
 */
export interface SourceProvenance {
  /** startedAt przebiegu discover, który dodał źródło (klucz do discover-runs.json) */
  run: string;
  /** gmina, dla której leciało discovery */
  town: string;
  /** model, który zaproponował źródło */
  model: string;
  /** zapytanie, w którego wynikach znalazł się ten URL (dopasowanie po adresie) */
  query?: string;
  /** dopasowany wynik wyszukiwarki — dokładnie to, co model o tym adresie widział */
  hit?: SearchResult;
  confidence?: number;
  /** jednozdaniowe uzasadnienie modelu */
  why?: string;
  /** wynik pierwszego pobrania URL-a (weryfikacja tuż po dodaniu) */
  firstFetch?: FetchProbe;
  /** ścieżki w prywatnym archiwum: surowe wyniki search + prompt/odpowiedź modelu */
  archive?: string[];
}

export interface SourcesFile {
  region: {
    name: string;
    center: { lat: number; lon: number };
    radius_km: number;
    discovered_at: string;
    discovery_method: string;
  };
  comment?: string;
  sources: Source[];
  fb_note?: string;
  todo_next_discovery?: string[];
}

export interface SearchResult {
  title: string | null;
  url: string | null;
  desc: string | null;
}
