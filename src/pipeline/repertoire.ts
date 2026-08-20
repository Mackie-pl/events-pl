/**
 * Repertuar zamiast wydarzeń: strony, na których ten sam tytuł stoi kilkanaście razy
 * i różni się wyłącznie godziną seansu.
 *
 * ZJAWISKO, nie dwa źródła. Kino, teatr i dom kultury z salą projekcyjną wypisują REPERTUAR:
 * „Odyseja" sześć razy dziennie, jutro znowu sześć, z innymi godzinami. Dla potoku to najgorszy
 * możliwy kształt treści naraz z trzech powodów i dopiero razem tłumaczą, czemu taki adres
 * odrzucamy PRZED pobraniem, a nie po ekstrakcji:
 *
 *   1. CACHE BLOKÓW NIGDY NIE TRAFI. Repertuar zmienia się co dobę z definicji, więc hash bloku
 *      zmienia się co dobę — to ta sama patologia, co kalendarz z ruchomym „dziś" w blocks.ts,
 *      tyle że nie do zamaskowania, bo zmienia się TREŚĆ, nie adres. Pomiar 2026-08-17:
 *      strona źródła `poznan.pl/mim/events/` miała 40 z 51 bloków z cache'a, a jej followup
 *      `/mim/events/seances/` — 24 z 68. I tak każdego dnia, w każdym przebiegu.
 *   2. PŁACIMY GŁÓWNIE ZA WYJŚCIE. Każdy seans wraca jako osobne wydarzenie: 66 z 86 wpisów
 *      `poznan-co-gdzie-kiedy` i 80 ze 100 wpisów `kultura-poznan` (2026-08-17) to seanse,
 *      czyli 11 869 i 13 381 tokenów wyjścia — najdroższa pozycja rachunku ekstrakcji.
 *   3. TO NIE SĄ WYDARZENIA, PO KTÓRE TU JESTEŚMY. W events.json 42 z 266 wpisów to seanse,
 *      a w samym `kultura-poznan` 34 z 44 — digest pokazuje repertuar kina zamiast tego,
 *      co się w gminie dzieje.
 *
 * SYGNAŁEM JEST CAŁY SEGMENT ŚCIEŻKI, nie podciąg adresu — i to jest tu cała ostrożność.
 * „Lato z Estradą - seans kina plenerowego - La Chimera" ma w slugu `seans-kina-plenerowego`
 * i JEST wydarzeniem; tak samo `/4r0C6pFWryAyR0aFNgbv_kino-na-wolnym` i `/rocketman-2019-…
 * -kino-letnie-w-dworze-skrzynki`. Dopiero segment RÓWNY `seances` znaczy „tu stoi repertuar".
 * Z tego samego powodu na liście nie ma `kino`: `/kino/` bywa działem instytucji, w którym
 * obok repertuaru wiszą pokazy specjalne i festiwale.
 *
 * Pomyłka jest tania w jedną stronę i droga w drugą, więc reguła celowo woli odciąć: fałszywe
 * odcięcie kosztuje listę seansów, których i tak nie chcemy publikować, a fałszywe przepuszczenie
 * to kilkanaście tysięcy tokenów wyjścia dziennie i digest zalany repertuarem.
 */
import { P } from "../config/index.js";
import { audit } from "../shared/audit.js";
import type { EventItem } from "../types/index.js";

/** Ścieżka adresu; adresu nie do rozłożenia (followup podany względnie) nie odrzucamy — tniemy ręcznie. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** Segment po dekodowaniu; `%2F` i inne kalectwa nie mogą wywrócić przebiegu. */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return seg.toLowerCase();
  }
}

/**
 * Segment, po którym poznaliśmy repertuar, albo `null`.
 *
 * Zwracamy SEGMENT, a nie `true`, bo notka śladu ma powiedzieć, co konkretnie zadecydowało.
 * „adres odrzucony przez regułę" jest dokładnie tą notatką, której ten potok nie chce.
 */
export function repertoireSegment(url: string): string | null {
  const marks = P.REPERTOIRE_URL_SEGMENTS.get();
  if (!marks.length) return null;
  for (const seg of pathOf(url).split("/")) {
    if (!seg) continue;
    const s = decodeSegment(seg);
    if (marks.includes(s)) return s;
  }
  return null;
}

/**
 * Odsiew wydarzeń stojących pod adresem repertuaru — po WSZYSTKICH ścieżkach naraz.
 *
 * Odrzucanie adresów przed pobraniem załatwia sprawę u źródła, ale nie każdy seans przychodzi
 * osobną podstroną: model potrafi wypisać wpis z listy głównej i podpisać go linkiem do karty
 * seansu. Ten odsiew jest więc dopełnieniem, nie dublem — a jego licznik odpowiada na pytanie,
 * czy takie przecieki w ogóle istnieją (zero znaczy „filtr adresów wystarcza").
 */
export function dropRepertoire(events: EventItem[]): { kept: EventItem[]; dropped: number } {
  const kept = events.filter((ev) => repertoireSegment(ev.source_url) === null);
  return { kept, dropped: events.length - kept.length };
}

/**
 * Adresy do pobrania bez repertuarów. IDEMPOTENTNA i to jest tu warunek, nie ozdoba:
 * wołamy ją kilka razy — na propozycjach modelu (żeby limit followupów nie poszedł na adresy,
 * których i tak nie pobierzemy), na liście odtworzonej ze `state.followupsBySource` przy
 * niezmienionej stronie i na propozycjach z dalszych stron listingu. Kolejne wywołanie nie ma
 * już czego odrzucić, więc nie dopisuje drugiej notki do śladu.
 *
 * Stoi TUTAJ, a nie w process-source.ts, odkąd tą samą bramką chodzi paginacja: repertuar
 * pod adresem strony 2 jest tym samym repertuarem, a druga kopia tych pięciu linii oznaczałaby
 * dwa miejsca do poprawienia przy następnej regule.
 */
export function fetchableUrls(urls: string[]): string[] {
  return urls.filter((u) => {
    const segment = repertoireSegment(u);
    if (!segment) return true;
    audit("url.skipped",
      `„/${segment}/" to repertuar, a nie lista wydarzeń — nie pobieramy tej podstrony`,
      { url: u, segment });
    return false;
  });
}
