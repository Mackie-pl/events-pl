/**
 * Port składowania. Reszta kodu nie wie, że dane leżą w plikach JSON w repo —
 * widzi wyłącznie te dwa interfejsy. Przejście na bazę to napisanie drugiej
 * implementacji i podmiana wiązań w storage/index.ts; ani potok, ani raporty
 * nie mają się o tym dowiedzieć.
 *
 * Dwa kształty, bo dane dzielą się na dwa rodzaje o różnych operacjach:
 *   - DOKUMENT  — jeden obiekt czytany i zapisywany w całości (rejestr, stan, wynik),
 *   - KOLEKCJA  — rosnąca lista rekordów z retencją (przebiegi, księga kosztów).
 * W bazie pierwszy zostałby wierszem/blobem, drugi tabelą — i dlatego nie
 * upychamy ich w jeden interfejs „read/write".
 */

export interface DocStore<T> {
  /** Brak dokumentu = wartość domyślna, nie wyjątek: pierwszy przebieg musi mieć od czego zacząć. */
  load(): Promise<T>;
  save(value: T): Promise<void>;
}

export interface CollectionStore<T> {
  all(): Promise<T[]>;
  /** Dopisuje rekordy i stosuje retencję. Pusta lista to no-op. */
  append(records: T[]): Promise<void>;
}

/**
 * Reguły przycinania kolekcji. Wyrażone deklaratywnie, bo w bazie te same intencje
 * realizuje DELETE/UPSERT, a nie filtrowanie tablicy w pamięci.
 */
export interface Retention<T> {
  /** Znacznik czasu rekordu (ISO) — oś sortowania. */
  at: (r: T) => string;
  /**
   * Granica wieku jako napis porównywalny leksykograficznie z `ageKey`. Napisy ISO
   * (i „YYYY-MM-DD") porównują się chronologicznie, więc jedno porównanie obsługuje
   * i dokładność do milisekundy (przebiegi), i do doby (księga kosztów) — bez
   * przesunięć o dzień, które daje mieszanie Date.parse z granicą dobową.
   */
  cutoff?: () => string;
  /** Co porównujemy z `cutoff`; domyślnie `at`. Księga kosztów przycina po dacie dziennej. */
  ageKey?: (r: T) => string;
  /** Dolna granica: tyle rekordów zostaje nawet po długiej przerwie w cronie. */
  minKeep?: number;
  /** Górna granica: sufit na wypadek wielu ręcznych przebiegów jednego dnia. */
  maxKeep?: number;
  /**
   * Klucz zastępowania. Rekord o tym samym kluczu nadpisuje poprzedni zamiast się dokleić —
   * ponowny zapis tego samego raportu nie ma podwajać kwoty w księdze. W bazie: UPSERT.
   */
  key?: (r: T) => string;
  /**
   * Odchudzanie starszych rekordów: szczegóły (wyniki wyszukiwarki) zostają tylko
   * w `keepDetailed` najnowszych, bo inaczej publiczne repo puchnie o setki kB na przebieg.
   */
  slim?: { keepDetailed: number; slim: (r: T) => T };
  /**
   * Normalizacja rekordu wczytanego ze składowiska. Pliki zapisane starszą wersją nie mają
   * nowych pól, więc typy opisują tu intencję, a nie gwarancję.
   */
  normalize?: (raw: unknown) => T;
}

/**
 * Koperta dla plików, w których rekordy siedzą obok metadanych. costs.json trzyma
 * przy wpisach stawki obowiązujące w chwili zapisu — bez nich starego wpisu nie da się
 * wytłumaczyć po zmianie cennika. W bazie: osobna kolumna albo tabela metadanych.
 */
export interface Envelope<T> {
  unwrap: (raw: unknown) => unknown[];
  wrap: (records: T[]) => unknown;
}
