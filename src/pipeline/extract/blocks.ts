/**
 * Podział treści na BLOKI i rozliczenie ich powtarzalności między dniami.
 *
 * Powód istnienia, w liczbach z 2026-08-06: rachunek to $0.80/dzień, z czego 99% to
 * `llm-extract` (346k tokenów wejścia = $0.35, 90k wyjścia = $0.45 na Haiku 4.5).
 * Cache w state.json trzyma hash CAŁEJ strony, więc wystarczy, że jedno wydarzenie
 * wypadnie z listy, i płacimy za odczytanie całej strony od nowa. Porównanie dwóch dni
 * estrada.poznan.pl (eval/estrada-compare-days) pokazuje skalę: 27 603 z 27 602 znaków
 * dnia B stoi identycznie w dniu A, przybyło ZERO znaków, a ubyła jedna wygasła karta.
 * Zapłaciliśmy pełną stawkę za stronę bez ani jednego nowego bajtu.
 *
 * Blok jest jednostką, dla której cache ma sens: `hash bloku → wydarzenia`, a wynik strony
 * to SUMA po blokach, które dziś na niej stoją. Usunięcie jest wtedy poprawne z definicji
 * (bloku nie ma → jego wydarzeń nie ma w sumie) i nie wymaga scalania niczego z niczym —
 * a to scalanie było jedynym miejscem, gdzie „wyślij modelowi diff" mogło po cichu zepsuć
 * events.json.
 *
 * TEN moduł jeszcze niczego nie cache'uje. Liczy tylko, ile dałoby się odzyskać —
 * bo zysk zależy od tego, czy 97% z estrady to reguła, czy wyjątek, a tego nie wiadomo
 * z dwóch plików. Segmentacja docelowo ma iść po DOM-ie (powtarzalne rodzeństwo = karty);
 * tutaj idzie po tekście, bo archiwum `raw/` trzyma treść już po html-to-text.
 */
import { sha256 } from "../../shared/hash.js";

import { looksLikeChrome } from "./chrome.js";

/**
 * CZEMU blok skończył się w tym miejscu. Jedno pole, a rozstrzyga pytanie, którego ślad
 * dotąd nie umiał postawić: „co ten podział w ogóle uznał za kartę, a co za resztę strony".
 *
 * Powód z 2026-08-19 (okpoznan.pl): lista filtrów to JEDEN akapit na 724 znaki, a jej
 * granica jest rzutem monetą z `isBoundary` — dzień w dzień ta sama treść w innej kolejności
 * partnerów raz zamyka blok (`content`), raz nie, i wtedy blok połyka sąsiadujący spis
 * miesięcy. Diagnoza wymagała odtworzenia podziału skryptem, bo w archiwum stały same
 * hashe: widać BYŁO, że blok jest nowy, nie było widać, że przesunęła się granica.
 *
 *   card    — krawędź karty z podziału po DOM-ie (powtarzalne rodzeństwo)
 *   post    — granica dana przez źródło, nie zgadywana (posty grupy FB)
 *   flip    — zmiana RODZAJU akapitu: chrom obok treści (patrz `segment`)
 *   content — granica z treści akapitu (`isBoundary`), jedyna odporna na przesunięcia
 *   ceiling — twardy sufit `maxChars`; JEDYNA granica zależna od pozycji, więc psuje
 *             lokalność i ma się odzywać rzadko — w śladzie widać, gdy zaczyna dominować
 *   end     — koniec ciętego kawałka, czyli reszta bufora. Przy podziale po DOM-ie każdy
 *             fragment MIĘDZY kartami tnie się osobno, więc `end` nie znaczy „koniec strony",
 *             tylko „dalej zaczyna się karta" — i dlatego bywa go na stronie kilka.
 */
export type BlockCut = "card" | "post" | "flip" | "content" | "ceiling" | "end";

export interface Block {
  text: string;
  hash: string;
  chars: number;
  cut: BlockCut;
}

/**
 * Treść widziana OCZAMI CACHE'A: bez tego, co w adresach przesuwa się samo z siebie.
 *
 * Powód w liczbach z 2026-08-14 (poznan.pl/mim/events/): blok z menu i kalendarzem ma
 * 2 664 znaki i ani jednego wydarzenia, a mimo to jedzie do modelu CODZIENNIE. Stoi w nim
 * `14 [/mim/events/2026-08-14/?sort=new&count=20]` — dzień „dziś" przesuwa się co dobę,
 * więc hash bloku zmienia się co dobę i cache nie ma jak trafić. Nigdy. To nie jest
 * przypadek jednego serwisu: kalendarz z podlinkowanymi dniami ma połowa miejskich CMS-ów.
 *
 * Maskujemy WYŁĄCZNIE do liczenia hasza — do modelu idzie `Block.text`, czyli treść bez
 * zmian. Kolizja (dwa różne bloki, jeden klucz) wymagałaby tekstów różniących się TYLKO
 * datą w adresie: ta sama nazwa, ta sama widoczna data, inny link. Wtedy wynik ekstrakcji
 * i tak byłby ten sam, bo daty model czyta z treści, nie ze ścieżki.
 *
 * Ta sama maska obowiązuje przy wyznaczaniu GRANIC bloków — i to jest tu nieoczywiste.
 * Bez tego zmiana wewnątrz akapitu przestawia jego `isBoundary`, granica wędruje i blok
 * z kalendarzem rozpada się na dwa o nowych haszach; maska na samym haszu bloku nie
 * uratowałaby wtedy niczego. Pomiar na dwóch dniach poznan.pl: blok 2 664 zn. rozpadał się
 * na 270 + 2 356 zn., oba nieznane cache'owi.
 */
export function stableKey(text: string): string {
  return text.replace(DATE_LINK, "/@@D@@$1");
}

/**
 * Adres z datą w ścieżce — RAZEM z doklejonym do niego zapytaniem.
 *
 * Zapytanie wchodzi do maski tylko TUTAJ i to jest cała ostrożność tej poprawki: kalendarz
 * odróżnia dzień „dziś" właśnie zapytaniem (`/2026-08-14/?sort=new&count=20` obok gołych
 * `/2026-08-13/`), więc maska na samej dacie zostawiłaby wędrujący `?…` i nic by nie dała.
 * Maskowanie WSZYSTKICH zapytań byłoby już za szerokie: serwis wypisujący wydarzenia jako
 * `?id=123` miałby wtedy dwie karty o jednym kluczu, gdy różnią się wyłącznie adresem.
 */
const DATE_LINK = /\/(?:19|20)\d\d-\d\d-\d\d(\/)?(?:\?[^\s\]]*)?/gu;

/** Hash TREŚCI po masce — klucz cache'a i podstawa granic. Patrz `stableKey`. */
const keyOf = (text: string): string => sha256(stableKey(text));

export interface SegmentOptions {
  /** twardy sufit; powyżej tniemy nawet bez granicy z treści (patrz niżej — psuje lokalność) */
  maxChars: number;
  /** średnio co tyle akapitów wypada granica wyznaczona treścią */
  targetParas: number;
}

export const DEFAULT_SEGMENT: SegmentOptions = { maxChars: 4000, targetParas: 6 };

/**
 * Akapity: ciągi wierszy rozdzielone pustą linią. html-to-text zostawia je jako naturalne
 * szwy dokumentu, więc granica bloku nigdy nie przetnie wiersza w połowie.
 */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.split("\n").map((l) => l.trimEnd()).join("\n").trim())
    .filter((p) => p.length > 0);
}

/**
 * Granica WYZNACZONA WYŁĄCZNIE TREŚCIĄ AKAPITU — i to jest tu cała sztuczka.
 *
 * Gdyby bloki były „co N akapitów" albo „co N znaków", usunięcie jednej karty przesunęłoby
 * wszystkie kolejne granice i unieważniło resztę strony: cache dawałby zero trafień
 * dokładnie wtedy, gdy jest najbardziej potrzebny. Tu zbiór cięć jest funkcją samych
 * akapitów (trik z rsync/FastCDC), więc usunięcie karty zmienia DOKŁADNIE JEDEN blok:
 * ten między dwiema granicami, które przeżyły. Test `blocks.test.ts` pilnuje tej własności.
 *
 * Pierwsza wersja miała jeszcze próg `minChars` („nie zamykaj bloku poniżej 400 znaków"),
 * żeby karta wydarzenia nie pękała w połowie. To był błąd i test go złapał: próg zależy od
 * tego, GDZIE skończył się poprzedni blok, więc po usunięciu karty przestawał się zgadzać
 * i granice wracały do synchronizacji dopiero po kilku blokach — 3 nowe bloki zamiast 1.
 * Całość karty jest zadaniem segmentacji po DOM-ie (powtarzalne rodzeństwo = jedna karta),
 * a nie progu rozmiaru; próg kupował ładniejsze bloki za jedyną własność, o którą tu chodzi.
 */
const isBoundary = (para: string, targetParas: number): boolean =>
  parseInt(keyOf(para).slice(0, 8), 16) % targetParas === 0;

/**
 * Blok z gotowego tekstu. Hash liczy się z TREŚCI po masce, więc jest kluczem cache'a;
 * `cut` NIE wchodzi do hasza — ta sama treść ma dawać ten sam klucz niezależnie od tego,
 * czy przyszła z karty, czy z akapitów, bo inaczej zmiana podziału zerwałaby cały cache.
 */
export const toBlock = (text: string, cut: BlockCut): Block =>
  ({ text, hash: keyOf(text), chars: text.length, cut });

const mkBlock = (paras: string[], cut: BlockCut): Block => toBlock(paras.join("\n\n"), cut);

/**
 * Rodzaj akapitu — chrom albo treść. Pamięć podręczna, bo ten sam akapit przechodzi tędy
 * i przy wyznaczaniu granic, i przy odsiewie całych bloków.
 */
const chromeCache = new Map<string, boolean>();
const isChrome = (para: string): boolean => {
  const hit = chromeCache.get(para);
  if (hit !== undefined) return hit;
  const v = looksLikeChrome(para).chrome;
  chromeCache.set(para, v);
  return v;
};

export function segment(text: string, opts: SegmentOptions = DEFAULT_SEGMENT): Block[] {
  const blocks: Block[] = [];
  const paras = paragraphs(text);
  let buf: string[] = [];
  let size = 0;
  for (const [i, p] of paras.entries()) {
    // ZMIANA RODZAJU zamyka blok PRZED dołożeniem akapitu — stopka i ogon karty mają wyjść
    // z tego dwoma blokami, a nie jednym. Dotąd granice stawiał wyłącznie hash akapitu, czyli
    // średnio co szósty, więc chrom obok karty zostawał z nią w jednym bloku, jeśli moneta
    // nie padła akurat między nimi. Blok mieszany jest nie do odsiania z definicji: zabrałby
    // ze sobą wydarzenie. Pomiar 2026-08-20 na 53 stronach — chrom uwięziony w blokach
    // niejednorodnych spadł z 31 814 do 11 270 znaków, kosztem 7,5% więcej bloków.
    //
    // LOKALNOŚĆ ZOSTAJE, i to jest tu warunek konieczny: rodzaj zależy wyłącznie od WŁASNEJ
    // treści akapitu, więc usunięcie karty nadal przestawia granice tylko w jej sąsiedztwie.
    if (buf.length && isChrome(p) !== isChrome(paras[i - 1]!)) {
      blocks.push(mkBlock(buf, "flip"));
      buf = [];
      size = 0;
    }
    buf.push(p);
    size += p.length + 2;
    // sufit jest bezpiecznikiem na strony bez ani jednej granicy, i JAKO JEDYNY zależy od
    // pozycji — czyli potrafi zepsuć lokalność. Dlatego jest wysoko: ma się odzywać rzadko.
    // Powód cięcia liczy się PRZED sufitem: gdy oba padają na tym samym akapicie, granica
    // wypadłaby tu również bez sufitu, więc `ceiling` znaczy „TYLKO sufit", a nie „też sufit".
    const boundary = isBoundary(p, opts.targetParas);
    if (boundary || size >= opts.maxChars) {
      blocks.push(mkBlock(buf, boundary ? "content" : "ceiling"));
      buf = [];
      size = 0;
    }
  }
  if (buf.length) blocks.push(mkBlock(buf, "end"));
  return blocks;
}

// ---------------- rozliczenie ----------------

export interface ReuseStat {
  blocks: number;
  newBlocks: number;
  chars: number;
  newChars: number;
  /** udział znaków, które NIE poszłyby do modelu (0..1) */
  reuse: number;
  /**
   * Bloki, których cache nie znał — czyli DOKŁADNIE to, co poszłoby do modelu.
   * Pomiar pokazuje je jako przykłady w panelu; docelowo to jest wejście wywołania.
   */
  fresh: Block[];
}

/**
 * Ile z tej treści model już kiedyś widział. `seen` jest MUTOWANE — symulacja cache'a
 * rosnącego przez kolejne dni, więc kolejność wywołań (dzień po dniu) ma znaczenie.
 */
export function reuseAgainst(blocks: Block[], seen: Set<string>): ReuseStat {
  const fresh: Block[] = [];
  let chars = 0, newChars = 0;
  for (const b of blocks) {
    chars += b.chars;
    if (!seen.has(b.hash)) {
      fresh.push(b);
      newChars += b.chars;
      seen.add(b.hash);
    }
  }
  return {
    blocks: blocks.length, newBlocks: fresh.length, chars, newChars,
    reuse: chars ? 1 - newChars / chars : 0, fresh,
  };
}

/**
 * SUFIT oszczędności: udział znaków dzisiejszej treści, które stoją też we wczorajszej —
 * liczony jako przecięcie multizbiorów wierszy.
 *
 * To górne ograniczenie dla DOWOLNEGO podziału na bloki (żaden nie odzyska wiersza, którego
 * wczoraj nie było), i dlatego jest w raporcie obok wyniku segmentacji: różnica między nimi
 * to koszt tego, że tniemy tekst tak, a nie idealnie. Bez sufitu nie dałoby się odróżnić
 * „ta strona naprawdę się zmienia" od „nasz podział jest do niczego".
 */
export function ceilingReuse(prev: string, next: string): number {
  const count = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of s.replace(/\r\n/g, "\n").split("\n")) {
      const k = l.trim();
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = count(prev), b = count(next);
  let total = 0, shared = 0;
  for (const [line, n] of b) {
    const w = (line.length + 1) * n;
    total += w;
    const common = Math.min(n, a.get(line) ?? 0);
    shared += (line.length + 1) * common;
  }
  return total ? shared / total : 0;
}
