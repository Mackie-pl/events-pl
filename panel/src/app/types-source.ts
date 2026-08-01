/**
 * Profil źródła ustalony w etapie 1 — mirrors ../../../src/types/source.ts.
 *
 * `Source.url` to korzeń serwisu (klucz dedupe i nośnik proweniencji), a te typy odpowiadają
 * na trzy osobne pytania: czy adres żyje i czym go pobrać (`ReachOutcome`), gdzie serwis
 * WYPISUJE wydarzenia (`EntryPoint`) i co oddaje maszynowo (`SourceCapability`).
 */

/** Werdykt drabiny osiągalności — mówi, KTÓRA naprawa adresu ma sens. */
export type ReachOutcome =
  | 'ok'
  | 'redirected' // odpowiada, ale pod innym adresem niż pytany
  | 'anti-bot' // 403/429 dla zwykłego fetcha, treść jest — trzeba przeglądarki
  | 'cert' // TLS odrzucony; http bywa sprawne
  | 'http-error' // serwer żyje, zasób nie — kandydat do naprawy przez search
  | 'dns-dead' // domena nie rozwiązuje się — jedyne wyjście to re-discovery
  | 'placeholder'; // 200, ale treść poniżej progu (parking/zaślepka)

/** Jeden szczebel drabiny: wypróbowany wariant adresu i to, co odpowiedział. */
export interface ReachStep {
  url: string;
  outcome: ReachOutcome;
  httpStatus?: number;
  err?: string;
}

/** Adres listy wydarzeń. `detailCount` to dowód z chwili rozpoznania, nie deklaracja. */
export interface EntryPoint {
  url: string;
  kind: 'listing' | 'feed' | 'api';
  detailPattern?: string;
  detailCount?: number;
  paginated?: boolean;
  confidence: number;
  via: 'heuristic' | 'llm';
}

/**
 * Maszynowe wyjście źródła, potwierdzone POBRANIEM. `datesParsed: 0` znaczy „endpoint jest,
 * ale terminów nie oddaje" — czyli do ekstrakcji się nie nadaje, mimo że zwraca 200.
 */
export interface SourceCapability {
  kind: 'rss' | 'wp-rest' | 'tribe' | 'ical' | 'jsonld';
  url: string;
  itemsSeen: number;
  datesParsed: number;
  checked: string;
}
