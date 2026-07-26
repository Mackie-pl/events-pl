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

export interface Source {
  id: string;
  name: string;
  type: SourceType;
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
