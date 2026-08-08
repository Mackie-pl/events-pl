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

export interface Block {
  text: string;
  hash: string;
  chars: number;
}

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
  parseInt(sha256(para).slice(0, 8), 16) % targetParas === 0;

/** Blok z gotowego tekstu. Hash liczy się z TREŚCI, więc jest kluczem cache'a. */
export const toBlock = (text: string): Block => ({ text, hash: sha256(text), chars: text.length });

const mkBlock = (paras: string[]): Block => toBlock(paras.join("\n\n"));

export function segment(text: string, opts: SegmentOptions = DEFAULT_SEGMENT): Block[] {
  const blocks: Block[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of paragraphs(text)) {
    buf.push(p);
    size += p.length + 2;
    // sufit jest bezpiecznikiem na strony bez ani jednej granicy, i JAKO JEDYNY zależy od
    // pozycji — czyli potrafi zepsuć lokalność. Dlatego jest wysoko: ma się odzywać rzadko.
    if (size >= opts.maxChars || isBoundary(p, opts.targetParas)) {
      blocks.push(mkBlock(buf));
      buf = [];
      size = 0;
    }
  }
  if (buf.length) blocks.push(mkBlock(buf));
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
