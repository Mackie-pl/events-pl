/**
 * `limit_per_input` liczony osobno dla każdej grupy, zamiast jednej stałej dla wszystkich.
 *
 * Bright Data rozlicza per-rekord, a grupy publikują w tempach różniących się o rząd
 * wielkości: sonda 2026-08-11 dała `allin-poznan` ~30 postów/dobę, podczas gdy grupy
 * wiejskie wyczerpują dobę pojedynczymi postami. Stała 50 dla obu znaczy, że za tę drugą
 * płacimy 50 rekordów, żeby przeczytać tydzień wstecz to samo, co wczoraj.
 *
 * REGULATOR, NIE WZÓR. Wprost z pomiaru wychodziłaby liczba zawyżona: okno krótsze od doby
 * trafia w godziny szczytu (te same 3.7 h dały 32.6/dobę, choć noc nie publikuje nic).
 * Dlatego limit nie liczy się z tempa, tylko z POKRYCIA — czy to, co wróciło, sięgnęło
 * wstecz aż do poprzedniego pobrania:
 *   - limit niewyczerpany → mamy wszystko, co grupa ma; można schodzić do tego, co realnie leży,
 *   - wyczerpany, a okno z zapasem pokrywa przerwę → schodzimy,
 *   - wyczerpany i okno KRÓTSZE niż przerwa → ucieka nam treść, podnosimy.
 *
 * Sufit `FB_GROUP_LIMIT_MAX` jest domyślnie równy dotychczasowej stałej (50), więc regulator
 * może wydatek wyłącznie ZMNIEJSZYĆ. To nie jest ostrożność na wyrost: pętla, która sama
 * sobie podnosi limit u dostawcy rozliczającego się per-rekord, jest dokładnie tym kształtem
 * awarii, który 2026-08-10 kosztował $8 (patrz adapters/brightdata.ts).
 *
 * Env:
 *   FB_GROUP_LIMIT_MAX     (opc.) sufit rekordów na grupę, domyślnie 50
 *   FB_GROUP_LIMIT_MIN     (opc.) podłoga, domyślnie 10
 *   FB_GROUP_LIMIT_MARGIN  (opc.) zapas ponad pokrycie, domyślnie 0.2 (20%)
 */
import { audit } from "../../shared/audit.js";
import type { FbGroupStats, PipelineState } from "../../types/index.js";

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const limitMax = (): number => num("FB_GROUP_LIMIT_MAX", 50);
export const limitMin = (): number => num("FB_GROUP_LIMIT_MIN", 10);
export const limitMargin = (): number => num("FB_GROUP_LIMIT_MARGIN", 0.2);

const clamp = (n: number): number => Math.min(limitMax(), Math.max(limitMin(), Math.ceil(n)));

/** Dni między dwiema datami YYYY-MM-DD; minimum 1, bo dwa przebiegi tego samego dnia
 *  nie znaczą „pokryj zero dni" — poprzednie pobranie i tak było kilka godzin temu. */
const daysBetween = (from: string, to: string): number =>
  Math.max(1, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000));

/** Limit dla najbliższego pobrania. Brak pomiaru = sufit, czyli dotychczasowe zachowanie. */
export function fbGroupLimit(id: string, state: PipelineState, today: string): number {
  const prev = state.fbGroupRate?.[id];
  if (!prev) return limitMax();
  const gap = daysBetween(prev.at, today);
  // zapisany `next` był policzony dla jednej doby przerwy; dłuższa przerwa (awaria crona,
  // wyciszenie, weekend bez przebiegu) wymaga proporcjonalnie więcej
  return clamp(prev.next * gap);
}

/**
 * Zapisuje wynik pobrania i wylicza limit na następny raz.
 *
 * Świadomie NIE zapisujemy `postsPerDay` jako sterowania — zostaje w raporcie jako pomiar,
 * a decyzję podejmuje pokrycie (patrz nagłówek modułu).
 */
export function noteFbGroupRate(
  id: string, stats: FbGroupStats, state: PipelineState, today: string,
): void {
  if (!stats.posts) return; // same wiersze błędu — tym zajmuje się fb-group-blocked
  const used = stats.limit; // limit, którym FAKTYCZNIE pobrano — nośnik `atLimit`
  const reg = (state.fbGroupRate ??= {});
  const gap = daysBetween(reg[id]?.at ?? today, today);
  const need = gap * (1 + limitMargin());
  const span = stats.spanDays ?? 0;

  let next: number;
  let why: string;
  if (!stats.atLimit) {
    // dostaliśmy wszystko, co grupa ma — tyle właśnie leży, plus zapas
    next = clamp(stats.posts * (1 + limitMargin()));
    why = `limit ${used} niewyczerpany (${stats.posts} postów to całość)`;
  } else if (span >= need) {
    // wyczerpany, ale okno sięga wstecz DALEJ niż trzeba — tyle rekordów starczy na przerwę
    next = clamp((stats.posts / span) * need);
    why = `okno ${span} dni pokrywa ${gap}-dniową przerwę z zapasem`;
  } else {
    // wyczerpany, a okno nie sięga do poprzedniego pobrania — coś nam ucieka
    next = clamp(used * (1 + limitMargin()) * (need / Math.max(span, 0.1)));
    why = `okno ${span} dni NIE pokrywa ${gap}-dniowej przerwy — treść ucieka`;
  }

  reg[id] = { at: today, next, postsPerDay: stats.postsPerDay ?? null, spanDays: span };
  if (next !== used) {
    audit("fb.group", `limit na następne pobranie: ${used} → ${next} · ${why}`,
      { was: used, next, spanDays: span, gap });
  }
}
