/**
 * Wydarzenia cykliczne — arytmetyka rytmu, bez śladu i bez efektów ubocznych.
 *
 * Podział, na którym stoi cała funkcja: MODEL PODAJE RYTM, KOD LICZY DATY, MAGAZYN TRZYMA
 * LISTĘ. Z plakatu „w każdą sobotę i niedzielę 20.06–31.08" tani model bez trudu odczyta
 * „soboty i niedziele", ale wyliczenie dwudziestu konkretnych dat to arytmetyka kalendarza,
 * na której się wywraca. Odwrotnie w magazynie: reguła rozciągnięta na zakres WYMYŚLA
 * terminy, których nigdzie nie było — „Kino letnie w Wirach" (events.json, 2026-08) to
 * środy i piątki, ale tylko w tygodniach 1 i 3, więc maska „sr,pt" dołożyłaby dwa seanse.
 * Dlatego `repeat` żyje wyłącznie na drucie, a w pliku leży jawna lista `dates`.
 *
 * Dlaczego shared/, a nie pipeline/: te same funkcje czyta potok (rozwijanie, zwijanie)
 * i renderowanie (digest, strona). Decyzje ze śladem stoją obok, w pipeline/series.ts.
 */
import type { EventItem } from "../types/index.js";

import { addDays, dayOfWeek, fmtShortPl } from "./dates.js";

/**
 * Sufit rozwinięcia. Nie oszczędność, tylko bezpiecznik: „codziennie" z `date_end` za rok
 * zrobiłoby z jednego wpisu trzysta rekordów w każdym przebiegu — a digest i tak sięga
 * najdalej na osiem dni w przód.
 */
export const MAX_OCCURRENCES = 60;

export type Repeat = { kind: "daily" } | { kind: "weekdays"; days: number[] };

/** Ogonki lecą pierwsze: źródła i modele gubią je wymiennie („sroda", „śr", „Śr"). */
const deascii = (s: string): string => s.toLowerCase()
  .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l")
  .replace(/ń/g, "n").replace(/ó/g, "o").replace(/ś/g, "s").replace(/[źż]/g, "z");

/**
 * Rozpoznanie dnia po PREFIKSIE, a nie po pełnym dopasowaniu: prompt prosi o „pn,wt,sr",
 * ale model bywa rozmowny i pisze „pon, wt, sroda". Prefiksy są rozłączne, więc kolejność
 * w tablicy niczego nie ukrywa.
 */
const DAY_PATTERNS: readonly (readonly [RegExp, number])[] = [
  [/^(nd|ndz|niedz)/, 0],
  [/^(pn|pon)/, 1],
  [/^wt/, 2],
  [/^(sr|srod)/, 3],
  [/^cz/, 4],
  [/^(pt|pia)/, 5],
  [/^(sb|sob)/, 6],
];

/**
 * Rytm z pola `repeat` albo null, gdy nie da się go odczytać.
 *
 * Jeden nierozpoznany człon unieważnia CAŁY rytm — „sb,niedziele parzyste" rozumiane jako
 * same soboty byłoby cichym wymyśleniem połowy terminów. Lepiej zostawić wpis jednorazowy:
 * wtedy widać brak, a nie fałsz.
 */
export function parseRepeat(raw: string): Repeat | null {
  const s = deascii(raw).trim();
  if (!s) return null;
  if (s.startsWith("codzienn")) return { kind: "daily" };
  const days = new Set<number>();
  for (const part of s.split(/[,;/\s]+/).filter(Boolean)) {
    const hit = DAY_PATTERNS.find(([re]) => re.test(part));
    if (!hit) return null;
    days.add(hit[1]);
  }
  return days.size ? { kind: "weekdays", days: [...days].sort((a, b) => a - b) } : null;
}

/** Terminy rytmu w zakresie [from, to] włącznie. Pusta lista, gdy zakres jest pusty. */
export function occurrences(rule: Repeat, from: string, to: string, cap = MAX_OCCURRENCES): string[] {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < cap; day = addDays(day, 1)) {
    if (rule.kind === "daily" || rule.days.includes(dayOfWeek(day))) out.push(day);
  }
  return out;
}

/**
 * Terminy wydarzenia wpadające w okno [from, to].
 *
 * Dwa kształty w jednej funkcji, bo konsument nie ma powodu ich rozróżniać:
 *  - seria (`dates`) → przefiltrowana lista terminów,
 *  - wydarzenie jedno- lub wielodniowe → JEDEN termin, pierwszy dzień widoczny w oknie.
 * To drugie zachowuje dzisiejsze zachowanie `overlaps()`: festiwal trwający cały tydzień
 * pokazuje się w sekcji raz, a nie siedem razy.
 */
export function occursIn(ev: EventItem, from: string, to: string): string[] {
  if (ev.dates?.length) return ev.dates.filter((d) => d >= from && d <= to);
  const end = ev.date_end ?? ev.date_start;
  if (ev.date_start > to || end < from) return [];
  return [ev.date_start > from ? ev.date_start : from];
}

/** „w każdą środę" — biernik, bo tylko środa, sobota i niedziela są rodzaju żeńskiego. */
const EVERY_PL = [
  "w każdą niedzielę", "w każdy poniedziałek", "w każdy wtorek", "w każdą środę",
  "w każdy czwartek", "w każdy piątek", "w każdą sobotę",
] as const;

/** Liczba mnoga — „soboty i niedziele". */
const PLURAL_PL = [
  "niedziele", "poniedziałki", "wtorki", "środy", "czwartki", "piątki", "soboty",
] as const;

/**
 * Kolejność do wypisania: polski tydzień zaczyna się w poniedziałek, a indeksy Date — w niedzielę.
 * Bez tego weekend czyta się „niedziele i soboty".
 */
const weekOrder = (day: number): number => (day + 6) % 7;

/** Ile terminów wypisujemy, zanim lista przestaje mieścić się w wierszu digestu. */
const LISTED_DATES = 5;

/** „poniedziałki, środy i czwartki" — spójnik przed ostatnim, jak po polsku. */
function joinPl(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} i ${parts[parts.length - 1]}`;
}

/**
 * Etykieta cyklu — to, co użytkownik czyta zamiast dwudziestu identycznych wierszy.
 * "" dla wydarzeń jednorazowych.
 *
 * Etykieta rytmiczna („w każdą środę") pada TYLKO wtedy, gdy lista terminów jest dokładnie
 * tym, co ten rytm generuje w swoim zakresie. Bez tej weryfikacji „Kino letnie w Wirach"
 * (śr+pt, ale co drugi tydzień) dostałoby podpis „środy i piątki do 21.08" i obiecywało
 * seanse, których nie ma. Gdy rytmu nie widać, wypisujemy po prostu terminy — mniej
 * elegancko, za to prawdziwie.
 *
 * Etykieta celowo NIE zależy od „dzisiaj": ten sam rekord opisuje tak samo digest, stronę
 * i archiwum, a data przebiegu nie jest częścią wydarzenia.
 */
export function seriesLabel(ev: EventItem): string {
  const dates = ev.dates;
  if (!dates || dates.length < 2) return "";
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const until = ` do ${fmtShortPl(last)}`;

  const days = [...new Set(dates.map(dayOfWeek))].sort((a, b) => a - b);
  const fits = (rule: Repeat): boolean =>
    occurrences(rule, first, last, dates.length + 1).join() === dates.join();

  if (fits({ kind: "daily" })) return `codziennie${until}`;
  if (days.length <= 3 && fits({ kind: "weekdays", days })) {
    const listed = [...days].sort((a, b) => weekOrder(a) - weekOrder(b));
    return listed.length === 1
      ? `${EVERY_PL[listed[0]!]}${until}`
      : `${joinPl(listed.map((d) => PLURAL_PL[d]!))}${until}`;
  }
  const shown = dates.slice(0, LISTED_DATES).map(fmtShortPl);
  return `terminy: ${shown.join(", ")}${dates.length > LISTED_DATES ? " …" : ""}`;
}
