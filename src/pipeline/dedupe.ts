/** Scalanie tego samego wydarzenia z kilku źródeł. */
import { eventKey } from "../shared/event-key.js";
import type { EventItem } from "../types/index.js";
import { DEDUPE_SYSTEM } from "./prompts.js";

/** Rekord, który przegrał scalanie, i ten, który go zastąpił. */
export interface DedupeDrop {
  loser: EventItem;
  winner: EventItem;
  /**
   * Po czym rekordy się zeszły. Ślad ma odpowiadać na „czemu to zniknęło", a te dwie
   * odpowiedzi znaczą co innego: `klucz` to identyczny tytuł i data (pewne), `zawieranie`
   * to jeden tytuł zawarty w drugim (heurystyka, którą warto obejrzeć).
   */
  why: "klucz" | "zawieranie";
}

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

/**
 * Scalanie po zawieraniu, w kubełkach (data + miejscowość). Miejscowość jest warunkiem
 * KONIECZNYM: „Kino letnie w Wirach" i „Swarzędzkie kino letnie" tego samego dnia to dwa
 * różne wydarzenia trzydzieści kilometrów od siebie.
 */
function foldContained(events: EventItem[]): DedupeResult {
  const slots: EventItem[] = [];
  const byBucket = new Map<string, number[]>();
  const losers: { loser: EventItem; slot: number }[] = [];

  for (const ev of events) {
    const key = `${ev.date_start}|${norm(ev.town)}`;
    const bucket = byBucket.get(key) ?? [];
    const hit = bucket.find((i) => sameEvent(slots[i]!, ev));
    if (hit === undefined) {
      byBucket.set(key, [...bucket, slots.push(ev) - 1]);
      continue;
    }
    // zwycięzcę rozstrzygamy na miejscu, ale wskazujemy go dopiero na końcu — w łańcuchu
    // A→B→C przegrany A ma pokazywać na C, a nie na pośrednie B
    if (richer(ev, slots[hit]!)) {
      losers.push({ loser: slots[hit]!, slot: hit });
      slots[hit] = ev;
    } else {
      losers.push({ loser: ev, slot: hit });
    }
  }
  return {
    events: slots,
    dropped: losers.map(({ loser, slot }) => ({ loser, winner: slots[slot]!, why: "zawieranie" as const })),
  };
}

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

  // drugie przejście dopiero na zwycięzcach pierwszego: po identycznych tytułach zostaje
  // mniej rekordów, więc porównań kwadratowych w kubełku jest mniej — a przede wszystkim
  // heurystyka nie ma szans nadpisać rozstrzygnięcia, które było pewne
  const loose = foldContained(out);
  // przegrany pierwszego przejścia mógł wskazywać rekord, który przegrał drugie —
  // przepinamy go na ostatecznego zwycięzcę, żeby ślad prowadził do rekordu z events.json
  const finalOf = new Map(loose.dropped.map((d) => [d.loser, d.winner]));
  for (const d of dropped) {
    const better = finalOf.get(d.winner);
    if (better) d.winner = better;
  }
  return { events: loose.events, dropped: [...dropped, ...loose.dropped] };
}
void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO
