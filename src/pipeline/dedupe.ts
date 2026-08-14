/** Scalanie tego samego wydarzenia z kilku źródeł. */
import { eventKey } from "../shared/event-key.js";
import type { EventItem } from "../types/index.js";
import { DEDUPE_SYSTEM } from "./prompts.js";

/** Rekord, który przegrał scalanie, i ten, który go zastąpił. */
export interface DedupeDrop {
  loser: EventItem;
  winner: EventItem;
  /**
   * Po czym rekordy się zeszły. Ślad ma odpowiadać na „czemu to zniknęło", a te odpowiedzi
   * znaczą co innego: `klucz` to identyczny tytuł i data (pewne), `oryginał` to dwa
   * udostępnienia TEGO SAMEGO postu (też pewne, i jako jedyne działa ponad miejscowością),
   * `zawieranie` to jeden tytuł zawarty w drugim (heurystyka, którą warto obejrzeć).
   */
  why: "klucz" | "oryginał" | "zawieranie";
}

/**
 * Werdykt scalania po polsku — tutaj, bo słownik należy do reguły, nie do miejsca, które
 * go drukuje. Dopisanie powodu bez zdania w tej mapie nie skompiluje się i to jest cel.
 */
export const DEDUPE_WHY: Record<DedupeDrop["why"], string> = {
  "klucz": "ten sam tytuł i data",
  "oryginał": "to samo udostępnienie oryginału",
  "zawieranie": "tytuł zawarty w tamtym",
};

export interface DedupeResult {
  events: EventItem[];
  /**
   * Przegrani — bez tego scalanie było jedyną decyzją potoku niezostawiającą śladu:
   * wydarzenie znikało z events.json i z panelu, a `source_id` cicho zmieniało się
   * na to źródło, które akurat zwróciło dłuższy JSON.
   */
  dropped: DedupeDrop[];
}

// normalizacja mieszka w shared/event-key.ts — raport plonu musi scalać identycznie
const keyOf = (ev: EventItem): string => eventKey(ev.title, ev.date_start);

// ---------------- drugie przejście: tytuł zawarty w tytule ----------------

/**
 * Urząd wypisuje wydarzenie z prefiksem organizatora albo programu, instytucja — samą nazwą.
 * Klucz po IDENTYCZNYM tytule nie ma tego jak zescalić, więc „Dożynki" z portalu gminy
 * i z ośrodka kultury szły do events.json dwa razy. Pomiar na 382 wydarzeniach: 14 par
 * duplikatów, których pierwsze przejście nie ruszyło.
 *
 *   [poznan-kultura] 10. LATO Z ESTRADĄ - ŻEGRZE - SEANS KINA PLENEROWEGO - CICHA DZIEWCZYNA
 *   [estrada]        SEANS KINA PLENEROWEGO: „CICHA DZIEWCZYNA
 *
 * ZAWIERANIE, a nie podobieństwo. Miara podobieństwa (Jaccard ≥ 0.5) scala „Kino letnie
 * w Wirach - Nomadland" z „Kino letnie w Wirach - Krudowie 2" — dwa różne filmy tego samego
 * cyklu, tego samego dnia. Przy zawieraniu żaden nie jest podzbiorem drugiego i oba zostają.
 */
const MIN_TOKEN = 4;

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const tokens = (s: string | null | undefined): Set<string> =>
  new Set(norm(s).split(" ").filter((w) => w.length >= MIN_TOKEN));

const within = (a: Set<string>, b: Set<string>): boolean =>
  a.size > 0 && [...a].every((t) => b.has(t));

/**
 * Czy to na pewno to samo wydarzenie. Data i miejscowość muszą się zgadzać (bucket), tytuł
 * jednego ma się zawierać w drugim — a przy tytule DWUWYRAZOWYM dochodzi warunek na miejsce.
 *
 * Ten ostatni warunek kupiony jest konkretnym przypadkiem: „KINO PLENEROWE" (Brama Poznania)
 * zawiera się w „…KINO PLENEROWE - PERFECT DAYS" (Lato z Estradą) tego samego dnia w Poznaniu,
 * a to dwa różne seanse w dwóch różnych miejscach. Dwa pospolite słowa nie niosą tożsamości.
 * Nie da się tego załatwić rzadkością słów: „kino letnie wirach" też jest pospolite, bo cykl
 * powtarza własne słowa — i tam scalanie JEST poprawne.
 *
 * Miejsce działa tylko jako zerwanie remisu przy krótkim tytule, bo samo w sobie bywa
 * przypisane błędnie (poznan-kultura potrafi podmienić adresy między wydarzeniami).
 */
function sameEvent(a: EventItem, b: EventItem): boolean {
  const ta = tokens(a.title), tb = tokens(b.title);
  if (!within(ta, tb) && !within(tb, ta)) return false;
  const shorter = ta.size <= tb.size ? ta : tb;
  if (shorter.size > 2) return true;
  const va = tokens(a.venue), vb = tokens(b.venue);
  if (!va.size || !vb.size) return true; // brak miejsca to brak sprzeciwu
  return [...va].some((t) => vb.has(t));
}

/** Bogatszy rekord wygrywa — ta sama reguła, co w pierwszym przejściu. */
const richer = (a: EventItem, b: EventItem): boolean =>
  JSON.stringify(a).length > JSON.stringify(b).length;

/** Wydarzenie ciągłe („trwa bez przerwy do"), w odróżnieniu od pojedynczego terminu. */
const isSpan = (ev: EventItem): boolean => ev.date_end !== null;

/**
 * Czy rekordy mają choć jeden wspólny dzień.
 *
 * Dedupe stoi PRZED foldSeries, więc `dates` tutaj jeszcze nie istnieje (a `expandRepeat`
 * je zdejmuje) — każdy rekord jest jednodniowy albo zakresem, i wystarczy przecięcie
 * przedziałów. Gdyby ta kolejność się kiedyś zmieniła, ta funkcja jest pierwszym miejscem
 * do poprawienia.
 */
const overlaps = (a: EventItem, b: EventItem): boolean =>
  a.date_start <= (b.date_end ?? b.date_start) && b.date_start <= (a.date_end ?? a.date_start);

/**
 * Czy porównywać te dwa rekordy — dwie reguły, bo kupione dwoma różnymi błędami.
 *
 * 1. TA SAMA DATA + zawieranie tytułu. Reguła pierwotna, patrz sameEvent().
 * 2. WSPÓLNY DZIEŃ + tytuł IDENTYCZNY po normalizacji. Dołożona, bo okpoznan-wydarzenia
 *    wypisuje tę samą wystawę w dwóch blokach jednej strony: raz jako zakres („Rodzinna
 *    wystawa sensoryczna", 28.07–06.10), raz jako rytm „codziennie" 11–23.08 z listy
 *    „co się dzieje w tym tygodniu". Po rozwinięciu rytmu żaden termin nie ma tej samej
 *    daty startu co zakres, więc reguła 1 ich nie widzi — a w digeście stały obok siebie
 *    cztery takie pary dziennie.
 *
 * Reguła 2 wymaga tytułu identycznego, nie zawartego, i to jest cała jej ostrożność:
 * przy zawieraniu zakres „Lato z Estradą" (cały czerwiec–sierpień) wchłonąłby każdy swój
 * seans z osobna, bo nazwa cyklu zawiera się w nazwie seansu i dzień zawsze wpada w zakres.
 * Wszystkie cztery zmierzone pary miały tytuł identyczny co do znaku.
 */
const comparable = (a: EventItem, b: EventItem): boolean => {
  if (!sameEvent(a, b)) return false;
  if (a.date_start === b.date_start) return true;
  return norm(a.title) === norm(b.title) && overlaps(a, b);
};

/**
 * Kto z pary zostaje: ZAKRES bije pojedynczy termin, a przy tym samym kształcie — bogatszy.
 *
 * Zakres wygrywa, bo inaczej scalanie kończy się w pół drogi: zakres 28.07–06.10 spotyka
 * dwanaście rozwiniętych terminów tego samego wydarzenia, więc gdyby wygrał pierwszy z nich,
 * pozostałe jedenaście przestałoby mieć z czym się scalać (nie nakładają się na siebie)
 * i w events.json zostałby jeden termin plus seria. To gorsze niż duplikat, od którego
 * wyszliśmy. Przy okazji zakres jest prawdziwszym opisem: wystawa naprawdę trwa do października,
 * a blok „co się dzieje w tym tygodniu" to tylko jej wycinek.
 */
const beats = (a: EventItem, b: EventItem): boolean =>
  isSpan(a) === isSpan(b) ? richer(a, b) : isSpan(a);

/**
 * Scalanie po zawieraniu tytułu, w kubełkach wyznaczonych przez `bucketOf`.
 *
 * Kubełek jest parametrem, bo mamy DWA sensowne podziały i oba są tym samym algorytmem:
 *   - po MIEJSCOWOŚCI — warunek konieczny przy heurystyce tytułów: „Kino letnie w Wirach"
 *     i „Swarzędzkie kino letnie" tego samego dnia to dwa wydarzenia 30 km od siebie;
 *   - po ORYGINALE — dwa udostępnienia tego samego postu FB. Tu miejscowość musi wypaść
 *     z klucza, bo to samo ogłoszenie wisi w grupach różnych gmin i `ev.town` domyka się
 *     wtedy miastem ŹRÓDŁA (`town ??= src.town`), czyli dwiema różnymi wartościami.
 *     Tożsamość niesie id oryginału, nie geografia.
 *
 * `comparable()` zostaje w obu przebiegach — jeden oryginał potrafi wypisywać kilka wydarzeń
 * (program, „co się dzieje w tym tygodniu"), a wtedy wspólne id NIE znaczy „ten sam termin".
 *
 * Data wypadła z klucza kubełka i przeniosła się do `comparable()` — inaczej reguła 2
 * (wspólny dzień) nie miałaby jak dopasować rekordów o różnych datach startu.
 */
function foldBy(
  events: EventItem[],
  bucketOf: (ev: EventItem, i: number) => string,
  why: DedupeDrop["why"],
): DedupeResult {
  /** `null` = rekord wchłonięty; indeksy zostają na miejscu, żeby kubełki się nie rozjechały */
  const slots: (EventItem | null)[] = [];
  /** slot → slot, który go wchłonął (albo on sam). Rozwija łańcuchy A→B→C. */
  const absorbedBy: number[] = [];
  const losers: { loser: EventItem; slot: number }[] = [];
  const byBucket = new Map<string, number[]>();

  const surviving = (i: number): number => {
    while (absorbedBy[i] !== i) i = absorbedBy[i]!;
    return i;
  };

  for (const [i, ev] of events.entries()) {
    const key = bucketOf(ev, i);
    const bucket = byBucket.get(key) ?? [];
    const hits = bucket.filter((i) => slots[i] !== null && comparable(slots[i]!, ev));
    if (!hits.length) {
      const seat = slots.push(ev) - 1;
      absorbedBy[seat] = seat;
      byBucket.set(key, [...bucket, seat]);
      continue;
    }

    // najpierw najlepszy z już zajętych miejsc, potem porównanie z nowym rekordem —
    // dopiero to rozstrzyga, czy nowy zostaje, czy dokłada się do przegranych
    let best = hits[0]!;
    for (const i of hits) if (beats(slots[i]!, slots[best]!)) best = i;
    if (beats(ev, slots[best]!)) {
      losers.push({ loser: slots[best]!, slot: best });
      slots[best] = ev;
    } else {
      losers.push({ loser: ev, slot: best });
    }
    // wszystkie pozostałe dopasowania idą do zwycięzcy — patrz beats()
    for (const i of hits) {
      if (i === best) continue;
      losers.push({ loser: slots[i]!, slot: i });
      slots[i] = null;
      absorbedBy[i] = best;
    }
  }

  return {
    events: slots.filter((ev): ev is EventItem => ev !== null),
    dropped: losers.map(({ loser, slot }) => ({ loser, winner: slots[surviving(slot)]!, why })),
  };
}

/**
 * Kubełek po oryginale. Wpis bez `origin` dostaje kubełek WŁASNY (`#i`), więc nie ma z czym
 * się zejść — przebieg po oryginałach nie rusza niczego spoza grup FB.
 */
const foldByOrigin = (events: EventItem[]): DedupeResult =>
  foldBy(events, (ev, i) => ev.origin?.key ?? `#${i}`, "oryginał");

const foldContained = (events: EventItem[]): DedupeResult =>
  foldBy(events, (ev) => norm(ev.town), "zawieranie");

/** Tania heurystyka; LLM-owy dedupe (DEDUPE_SYSTEM) do podpięcia dla niejednoznacznych par. */
export function dedupe(events: EventItem[]): DedupeResult {
  const seen = new Map<string, EventItem>();
  const out: EventItem[] = [];
  const losers: { loser: EventItem; key: string }[] = [];
  for (const ev of events) {
    const key = keyOf(ev);
    const prev = seen.get(key);
    if (prev) {
      if (JSON.stringify(ev).length > JSON.stringify(prev).length) {
        out[out.indexOf(prev)] = ev; // zachowaj bogatszy rekord
        seen.set(key, ev);
        losers.push({ loser: prev, key });
      } else {
        losers.push({ loser: ev, key });
      }
      continue;
    }
    seen.set(key, ev);
    out.push(ev);
  }
  // zwycięzcę rozwiązujemy dopiero teraz: w łańcuchu A→B→C w events.json ląduje C,
  // więc wskazywanie przegranemu A pośredniego B byłoby mylące
  // seen ma klucz każdego przegranego — trafił tam przy pierwszym wystąpieniu
  const dropped: DedupeDrop[] = losers.map(({ loser, key }) =>
    ({ loser, winner: seen.get(key)!, why: "klucz" }));

  // kolejne przejścia dopiero na zwycięzcach poprzedniego: po identycznych tytułach zostaje
  // mniej rekordów, więc porównań kwadratowych w kubełku jest mniej — a przede wszystkim
  // heurystyka nie ma szans nadpisać rozstrzygnięcia, które było pewne.
  //
  // ORYGINAŁ przed MIEJSCOWOŚCIĄ, bo jest pewniejszy: wspólne id postu to ta sama treść
  // udostępniona dwa razy, a zawieranie tytułów to zgadywanie. Gdyby kolejność była odwrotna,
  // scalanie po miejscowości rozstrzygałoby pary, o których wiemy więcej niż ono.
  const byOrigin = foldByOrigin(out);
  const loose = foldContained(byOrigin.events);
  // Przegrany wcześniejszego przejścia mógł wskazywać rekord, który przegrał późniejsze —
  // przepinamy go na ostatecznego zwycięzcę, żeby ślad prowadził do rekordu z events.json.
  // Przepięcie idzie przejście po przejściu: przy trzech przebiegach jedno przepięcie zostawia
  // wskazanie o krok za krótkie (A→B, B→C, C→D), a to prowadzi do rekordu, którego już nie ma.
  const rechain = (drops: DedupeDrop[], next: DedupeDrop[]): void => {
    const finalOf = new Map(next.map((d) => [d.loser, d.winner]));
    for (const d of drops) {
      const better = finalOf.get(d.winner);
      if (better) d.winner = better;
    }
  };
  rechain(dropped, byOrigin.dropped);
  const earlier = [...dropped, ...byOrigin.dropped];
  rechain(earlier, loose.dropped);
  return { events: loose.events, dropped: [...earlier, ...loose.dropped] };
}
void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO
