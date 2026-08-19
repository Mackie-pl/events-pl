/** Ślad decyzyjny przebiegu (audit.json) — krok po kroku, źródło po źródle. */

/**
 * Zamknięty słownik kroków. Zamknięty celowo: panel dobiera do rodzaju ikonę i kolor,
 * a dopuszczenie wolnego tekstu zamieniłoby ślad w logi — czyli w to, czym ten plik
 * ma NIE być. Nowy rodzaj decyzji = nowa pozycja tutaj, świadomie.
 */
export type AuditKind =
  /** źródło w ogóle nietknięte (fanpage FB / URL oznaczony jako martwy) */
  | "skip"
  /** pobranie strony źródła */
  | "fetch"
  /** 403/429 przy zwykłym fetchu → druga próba przez przeglądarkę */
  | "fetch.fallback"
  /** werdykt porównania treści: 304 / ten sam hash / zmiana */
  | "content"
  /** wydarzenia odtworzone z cache, bez wywołania modelu */
  | "cache.hit"
  /** wybór wyjścia maszynowego (tribe/ical/jsonld) zamiast skrobania HTML-a */
  | "capability"
  /** rekordy maszynowe → wydarzenia: ile weszło, ile odpadło i dlaczego */
  | "capability.parsed"
  /** wyjście maszynowe nic nie dało — powrót na HTML + model */
  | "capability.fallback"
  /** wywołanie modelu (ekstrakcja tekstu albo plakat) */
  | "llm"
  /** wydarzenie odrzucone przez potok (brak daty startu, niezgodność ze schematem, półkolonie) */
  | "event.dropped"
  /** podział strony na bloki i rozliczenie cache'a: ile z cache, ile do modelu */
  | "block"
  /** bloki → wydarzenia: co dały świeże, co cache, i gdzie leży rozliczenie blok po bloku */
  | "block.parsed"
  /** wydarzenia odsiane jako minione — z cache'a bloków albo prosto od modelu */
  | "event.past"
  /** adres odrzucony PRZED pobraniem, bo stoi pod nim repertuar, a nie wydarzenia */
  | "url.skipped"
  /** model wskazał podstrony / PDF-y / plakaty do dociągnięcia */
  | "followup.proposed"
  /** adres followupa skonfrontowany z inwentarzem strony: przyciągnięty do prawdziwego albo odrzucony */
  | "followup.url"
  /** wpis o kształcie strony programu: sonda adresu i werdykt, czy stał pod nim program */
  | "container"
  /** wynik jednego followupa */
  | "followup"
  /** linki facebook.com/events/… wyłuskane z treści */
  | "fb.harvest"
  /** rytm publikacji grupy FB i werdykt dostępności (płatne rekordy vs. faktyczne posty) */
  | "fb.group"
  /** próg opłacalności kanału FB: koszt za wydarzenie, którego nie dała żadna strona */
  | "fb.value"
  /** regulator budżetu kanału FB: kolejka wartości, linia cięcia i cena źródła brzegowego */
  | "fb.budget"
  /** geokodowanie miejsca (Nominatim + cache) */
  | "geo"
  /** rekord przegrał scalanie duplikatów */
  | "dedupe.dropped"
  /** wydarzenie cykliczne: rytm rozwinięty na terminy albo powtórzenia zwinięte w serię */
  | "series"
  /** redakcja danych kontaktowych przed publikacją */
  | "pii"
  /** domknięcie: status źródła i tyle wydarzeń poszło dalej */
  | "done";

/** Wartości płaskie — ślad ma być czytelny w surowym JSON-ie, nie być dumpem stanu. */
export type AuditDetail = Record<string, string | number | boolean | null | undefined>;

export interface AuditStep {
  /** ms od startu przebiegu — krócej niż ISO i od razu mówi „kiedy w przebiegu" */
  ms: number;
  step: AuditKind;
  /** jedno zdanie po polsku: DECYZJA, nie stan. To jest właściwa treść śladu. */
  note: string;
  /** dodatki, które panel formatuje albo linkuje (url, koszt, liczby) */
  detail?: AuditDetail;
}

export interface SourceTrail {
  /** id źródła albo RUN_SCOPE dla kroków całego przebiegu (dedupe, redakcja, publikacja) */
  id: string;
  steps: AuditStep[];
  /** ile kroków ucięto po przekroczeniu limitu; brak = ślad kompletny */
  truncated?: number;
}

export interface RunTrail {
  /** startedAt przebiegu — ten sam klucz, co w runs.json i costs.json */
  run: string;
  /** YYYY-MM-DD */
  day: string;
  sources: SourceTrail[];
}
