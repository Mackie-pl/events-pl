/**
 * Rozpoznanie CHROMU strony BEZ modelu: menu, zgody na ciasteczka, stopki prawne, paski
 * filtrów i stron — treść, która na polskich stronach miejskich brzmi wszędzie tak samo.
 *
 * To nie jest lista wyjątków per źródło, tylko opis ZJAWISKA. Chrom polskiego CMS-u ma
 * zamknięte słownictwo („Polityka prywatności", „Deklaracja dostępności", „Mapa strony",
 * „Przejdź do treści") i wspólny kształt: krótkie wiersze, dużo odnośników, ZERO dat
 * i godzin. Ostatnie jest najmocniejsze — pomiar na 681 blokach z 35 stron (2026-08-19):
 * datę niesie 91% bloków, z których wyszło wydarzenie, i 22% pozostałych; godzinę
 * odpowiednio 67% i 10%.
 *
 * ASYMETRIA BŁĘDU rozstrzyga kształt każdej reguły. Fałszywe „to chrom" kasuje wydarzenie
 * na zawsze i nikt się nie dowie; fałszywe „to treść" kosztuje ułamek centa i widać je
 * w tabeli jałowych bloków. Dlatego data albo godzina w treści to WETO — blok z nimi nigdy
 * nie jest chromem, choćby miał wszystkie inne cechy menu.
 *
 * Skuteczność (2026-08-20, 35 stron źródeł + 18 podstron, zero fałszywych alarmów na 219
 * blokach z wydarzeniami): 33% znaków jałowych na stronach źródeł, 29% na podstronach.
 */

/** Nazwa miesiąca w dowolnej odmianie — polski CMS pisze daty słownie równie często, co cyframi. */
const MONTH =
  /\b(?:stycz|lut(?:y|ego)|marc|marz|kwie|maj|czerw|lip|sierp|wrze|paździer|listopad|grud)/iu;

/**
 * 12.08, 12-08-2026, 2026-08-12 — z zakresami dnia i miesiąca, nie „dwie cyfry przez kreskę".
 *
 * Zakresy są tu po to, żeby NUMER TELEFONU przestał wyglądać jak data: `61-814-82-62` ze
 * stopki GOSiR-u Dopiewo blokował weto na całym bloku kontaktowym, czyli najczystszym chromie,
 * jaki jest. Kotwice `(?<!\d)`/`(?!\d)` domykają to samo od strony dłuższych ciągów cyfr.
 */
const DATE_NUM =
  /(?<!\d)(?:(?:[0-2]?\d|3[01])[.\-/](?:0?\d|1[0-2])(?:[.\-/]\d{2,4})?|\d{4}-\d{2}-\d{2})(?!\d)/u;

/** 19:00, 19.00 — godzina bywa jedynym śladem wydarzenia w karcie bez daty. */
const TIME = /\b\d{1,2}[:.]\d{2}\b/u;

/**
 * Słownictwo MOCNE: hasła, które w opisie wydarzenia nie mają prawa stanąć.
 *
 * Nie ma tu ani „aktualności", ani „wydarzenia", choć oba są w chromie częstsze — stoją też
 * w tytułach i zajawkach, więc kosztowałyby karty.
 */
const STRONG_WORDS = [
  // zgody i prawo
  "polityka prywatności", "polityki prywatności", "pliki cookies", "plików cookies",
  "pliki cookie", "plików cookie", "wykorzystujemy pliki", "używamy plików", "korzysta z plików",
  "zgodę na przetwarzanie", "administratorem danych", "przetwarzania danych osobowych",
  "deklaracja dostępności", "deklarację dostępności", "rodo", "wszelkie prawa zastrzeżone",
  "regulamin serwisu", "ustawienia cookies", "niezbędne cookies",
  // nawigacja i sterowanie serwisem
  "strona główna", "mapa strony", "przejdź do treści", "przejdź do menu", "menu główne",
  "javascript:void", "biuletyn informacji publicznej", "bip", "wersja kontrastowa",
  "rozmiar czcionki", "zmień rozmiar", "wyczyść filtry", "zapisz się do newslettera",
  "wpisz szukaną", "wyszukiwarka", "szukaj w serwisie",
];

/**
 * Hasła-GUZIKI: liczą się TYLKO wtedy, gdy stanowią cały wiersz.
 *
 * Powód jest pomiarowy i kosztował fałszywy alarm (2026-08-20, bw.poznan.pl). „Czytaj więcej"
 * stało w jednym worku z „polityką prywatności" i przy klasyfikacji akapitami wystarczyło,
 * by zajawka prawdziwego wydarzenia — „Zapraszamy na spotkanie z Julem Łyskawą, uhonorowanym
 * nagrodą… Czytaj więcej [/…]" — została uznana za chrom. Cztery karty biblioteki z rzędu.
 *
 * Zdanie zakończone guzikiem to nadal zdanie. Guzik jest chromem, gdy jest SAM.
 */
const BUTTON_LINES = [
  "czytaj więcej", "pokaż więcej", "zobacz więcej", "zobacz wszystkie", "wróć do listy",
  "powrót do listy", "poprzednia strona", "następna strona", "zaloguj", "wyloguj",
  "rejestracja", "newsletter", "akceptuję wszystkie", "zamknij", "menu", "szukaj",
  "ustawienia", "kontakt",
];

/**
 * Wiersz paska stron: `* 2 [/wydarzenia?pno=2]`, `« Poprzedni`, `3 (aktualna)`, `>>`.
 * Sama liczba albo sama strzałka, opcjonalnie z adresem — i nic więcej.
 */
const PAGER =
  /^[*\s]*(?:[«»<>←→]+|\d{1,3}|poprzedni\w*|następn\w*|nastepn\w*)\s*(?:\(aktualna\))?\s*(?:\[[^\]]*\])?[*\s]*$/iu;

export interface ChromeVerdict {
  chrome: boolean;
  /** decyzja po polsku, jednym zdaniem — ten sam tekst idzie do notki śladu */
  why: string;
}

const NOT = (why: string): ChromeVerdict => ({ chrome: false, why });

/**
 * Tekst sprowadzony do samych słów rozdzielonych spacjami, w obwódce ze spacji.
 *
 * Dzięki temu trafienie hasła sprawdza się zwykłym `includes(" hasło ")` i JEST na granicy
 * słowa — bez budowania wyrażeń z escapowaniem. Powód jest z pomiaru, nie z ostrożności:
 * pierwsza wersja szukała `includes("rodo")` i wzięła kartę PosiR-u z dwoma wydarzeniami
 * za stopkę prawną, bo „rodo" siedzi w „mięDZYNaRODOwe". Tak samo „bip" w „bipolarny".
 */
const wordy = (text: string): string =>
  ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Wiersz sprowadzony do słów, z odciętym adresem — „Czytaj więcej [/x]" → „czytaj więcej". */
const bare = (line: string): string =>
  line.replace(/\[[^\]]*\]/gu, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/** Kształt bloku policzony raz — wszystkie reguły poza słownictwem patrzą właśnie na to. */
interface Shape {
  lines: string[];
  /** udział wierszy krótszych niż cztery słowa */
  words3: number;
  /** udział wierszy krótszych niż siedem słów */
  words6: number;
  links: number;
  buttons: number;
  pages: number;
}

function shapeOf(text: string): Shape {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const share = (n: number): number => (lines.length ? n / lines.length : 0);
  return {
    lines,
    words3: share(lines.filter((l) => l.split(/\s+/u).length <= 3).length),
    words6: share(lines.filter((l) => l.split(/\s+/u).length <= 6).length),
    links: share(lines.filter((l) => l.includes("[")).length),
    buttons: lines.filter((l) => BUTTON_LINES.includes(bare(l))).length,
    pages: lines.filter((l) => PAGER.test(l)).length,
  };
}

/**
 * Dowód z samego KSZTAŁTU, gdy w bloku nie padło ani jedno słowo-świadek. Progi są tu wyżej
 * niż przy słownictwie, bo to jedyne reguły bez potwierdzenia w treści.
 */
function shapeVerdict(text: string, s: Shape): ChromeVerdict | null {
  // czyste menu: prawie same odnośniki w krótkich wierszach i ani jednej liczby
  if (s.links >= 0.7 && s.words3 >= 0.8 && s.lines.length >= 4 && !/\d/u.test(text)) {
    return { chrome: true, why: "sam spis odnośników w krótkich wierszach, bez jednej liczby" };
  }
  // DRZEWO OFERTY: „Teatr [/oferta-zajec/teatr.html] * Do Góry [/…]" — spis podstron, w którym
  // nazwy bywają dłuższe niż trzy słowa, a w adresach stoją cyfry. Mierzone na mdk1/mdk2.poznan.pl:
  // 3 201 i 3 504 zn. dziennie, zero wydarzeń od początku rejestru.
  if (s.links >= 0.85 && s.words6 >= 0.9 && s.lines.length >= 6) {
    return { chrome: true, why: "spis podstron: same odnośniki bez daty i godziny" };
  }
  // PASEK STRON: wiersz, który jest samą liczbą (ewentualnie ze strzałką i adresem), nigdy nie
  // jest wydarzeniem — „2 [/wydarzenia?pno=2]" nie da się pomylić z kartą.
  if (s.pages >= 4 && s.pages / s.lines.length >= 0.6) {
    return { chrome: true, why: `pasek stron: ${s.pages} wierszy z samymi numerami` };
  }
  if (s.buttons >= 2 && s.buttons / s.lines.length >= 0.5) {
    return { chrome: true, why: `${s.buttons} wiersze-guziki i nic poza nimi` };
  }
  return null;
}

/**
 * Czy ten fragment to chrom. Dwie bramki po kolei: bezwarunkowe weto daty i godziny,
 * a potem dowód pozytywny — słownictwo albo kształt.
 *
 * ODSTĘPSTWO DLA STOPEK PRAWNYCH ZOSTAŁO ZMIERZONE I ODRZUCONE (2026-08-19). Kusiło mocno:
 * „pliki cookies" obok „polityki prywatności" nie stoi w opisie koncertu, a dwa najgrubsze
 * banery w rejestrze (poznan.pl i kultura.poznan.pl, po 2 267 zn.) mają w sobie datę i przez
 * to nie przechodzą; odstępstwo podnosiło odzysk z 28% do 37% znaków jałowych. Za każdym
 * razem, gdy dokładałem do niego warunek bezpieczeństwa (proza zamiast odnośników, brak
 * wiersza „data + adres"), znajdował się kolejny blok z prawdziwym wydarzeniem: najpierw
 * ok-lubon.pl z ogonem karty nad stopką, potem podstrona tego samego serwisu, gdzie opis
 * („6 sierpnia 2026 … Zapraszamy na moc sierpniowych atrakcji") sąsiaduje z polityką
 * prywatności BEZ żadnego odnośnika, więc nie ma się czego chwycić. Wniosek jest o granicach
 * bloków, nie o słowniku — i dlatego odpowiedzią jest drobniejszy podział (patrz `blocks.ts`),
 * a nie słabsze weto.
 */
export function looksLikeChrome(text: string): ChromeVerdict {
  if (MONTH.test(text) || DATE_NUM.test(text)) return NOT("jest data — to może być wydarzenie");
  if (TIME.test(text)) return NOT("jest godzina — to może być wydarzenie");

  const s = shapeOf(text);
  if (!s.lines.length) return NOT("pusty fragment");

  const words = wordy(text);
  const hits = STRONG_WORDS.filter((w) => words.includes(` ${wordy(w).trim()} `));
  if (hits.length >= 2) {
    return { chrome: true, why: `słownictwo chromu: ${hits.slice(0, 3).join(", ")}` };
  }
  if (hits.length === 1 && (s.words3 >= 0.6 || s.links >= 0.5)) {
    return { chrome: true, why: `„${hits[0]}" w bloku z samych krótkich wierszy i odnośników` };
  }
  return shapeVerdict(text, s) ?? NOT(hits.length ? "za mało poszlak" : "brak słownictwa chromu");
}

/**
 * Udział ZNAKÓW chromu wśród podanych akapitów (0..1).
 *
 * Znaki, nie sztuki: jednowierszowy „Menu" i spis oferty na 3 500 znaków to dwie różne wagi,
 * a decyzja, którą to karmi (`dom-blocks.ts`: „czy ta karta jest w istocie menu"), pyta
 * właśnie o masę. Akapity przychodzą gotowe, bo `paragraphs()` mieszka w `blocks.ts` —
 * import w drugą stronę zrobiłby cykl.
 */
export function chromeShare(paras: string[]): number {
  let all = 0, chrome = 0;
  for (const p of paras) {
    all += p.length;
    if (looksLikeChrome(p).chrome) chrome += p.length;
  }
  return all ? chrome / all : 0;
}
