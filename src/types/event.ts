/**
 * Wydarzenie i plik wynikowy events.json.
 *
 * Kształt tego, co zwraca MODEL, mieszka w event-schema.ts — tam jest jedno źródło prawdy
 * dla typu, promptu i `response_format`. Tutaj zostaje wyłącznie to, czego model nie
 * produkuje: pola dopisywane przez potok po ekstrakcji.
 */

import type { Followup, ModelEvent } from "./event-schema.js";
import type { GeoWhere } from "./geo.js";
import type { BdUsage } from "./usage.js";

export type { AgeRange, Followup, Price, SubSlot } from "./event-schema.js";

/**
 * KSZTAŁT TERMINU W MAGAZYNIE — trzy możliwości i nigdy dwie naraz:
 *
 *   jednodniowe  date_start,                      date_end: null, dates: brak
 *   zakres       date_start + date_end,                           dates: brak
 *   seria        date_start + dates[],            date_end: null
 *
 * Rozłączność jest wymuszona w pipeline/series.ts i nie jest kosmetyką — `date_end` niosło
 * kiedyś trzy znaczenia naraz („trwa bez przerwy", „tu kończy się rytm", „ten wpis jest już
 * zwinięty") i każde z dwóch ostatnich wyprodukowało błąd w digeście: zakres rytmu czytany
 * jako „trwa bez przerwy" wypisał zajęcia na dzień, w którym się nie odbywają, a `date_end`
 * w roli znacznika „przetworzone" zamieniało jedno wydarzenie w kilka, po jednym na przebieg.
 *
 * Stąd `date_end` znaczy DOKŁADNIE „trwa bez przerwy do", a ostatni dzień wydarzenia — bez
 * względu na kształt — liczy `lastDay()` z pipeline/extract/block-cache.ts. `repeat` przychodzi
 * z drutu (model) i nie przekracza `expandRepeat`; w magazynie jest zawsze puste.
 */
/**
 * Post, którego UDOSTĘPNIENIEM jest wpis z grupy FB (`original_post` u Bright Data).
 *
 * Pomiar z 2026-08-14 (221 postów, 14 grup): 43% wpisów to udostępnienia, a termin siedzi
 * wyłącznie w oryginale w 31.6% z nich — przypadek odwrotny (termin tylko w podpisie
 * udostępniającego) nie wystąpił ani razu, jeśli nie liczyć oryginałów bez tekstu.
 * Stąd `key`: dwa wpisy z RÓŻNYCH grup wskazujące ten sam oryginał to na pewno to samo
 * ogłoszenie — tożsamość pewna, bez modelu i bez heurystyki tytułów.
 */
export interface EventOrigin {
  /** `original_post.post_id` (stabilny), a gdy go nie ma — adres oryginału */
  key: string;
  /** adres oryginału: post organizatora, nie repost w grupie */
  url: string;
}

export interface EventItem extends ModelEvent {
  /** dopisywane w process-source.ts / fb-events.ts — model o źródle nie wie */
  source_id?: string;
  /** dopisywane w process-source.ts dla postów-udostępnień z grup FB */
  origin?: EventOrigin;
  /** dopisywane po geokodowaniu (Nominatim + cache) */
  geo?: { lat: number; lon: number } | null;
  /**
   * Gdzie to wydarzenie leży względem regionu — werdykt geokodera, nie zgadywanie z tekstu.
   * `abroad` odsiewa `pipeline/locality.ts`; `far` na razie WYŁĄCZNIE mierzymy.
   */
  locality?: GeoWhere;
  /**
   * Terminy serii, rosnąco; brak pola = wydarzenie nie jest serią. Dopisuje foldSeries().
   *
   * Jawna LISTA, nie reguła — „Kino letnie w Wirach" to środy i piątki, ale co drugi
   * tydzień, więc rytm rozciągnięty na zakres wymyśliłby dwa nieistniejące seanse.
   * Niezmiennik: `date_start` to pierwszy element. Ostatniego NIE ma w `date_end` — seria
   * nie jest zakresem, a duplikowanie go w polu o innym znaczeniu było właśnie tą pomyłką,
   * którą opisuje nagłówek wyżej.
   */
  dates?: string[];
}

export interface ExtractionResult {
  events: EventItem[];
  followups?: Followup[];
  /**
   * Czy dało się odczytać odpowiedź modelu. Brak pola = odczytana w całości.
   *
   * Do 2026-08 parser połykał wyjątek i zwracał pustą listę, więc ucięta odpowiedź wyglądała
   * IDENTYCZNIE jak strona bez wydarzeń: `status: "empty"` i nic więcej. Trzy poznańskie
   * źródła stały tak przez pięć przebiegów, płacąc ~$0.49 dziennie za zero wydarzeń.
   */
  parse?: "no-json" | "bad-json" | "truncated";
  /** ile kompletnych wydarzeń wyłuskano z uciętej odpowiedzi */
  recovered?: number;
}

export interface EventsFile {
  generated: string;
  events: EventItem[];
  errors: PipelineError[];
  brightdata?: BdUsage;
}

export interface PipelineError {
  id: string;
  err: string;
  followup?: string;
}
