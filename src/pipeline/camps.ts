/**
 * Półkolonie — turnus, nie wydarzenie.
 *
 * Półkolonie to wielodniowy, płatny turnus z zapisami i limitem miejsc: rodzic zapisuje
 * dziecko w maju, a nie sprawdza w czwartek wieczorem, co robić w piątek. W serwisie taki
 * wpis zajmuje miejsce wydarzenia, na które da się po prostu przyjść, i — przez `date_end`
 * rozciągnięty na cały turnus — wisi w każdej sekcji digestu przez pięć dni z rzędu.
 *
 * Dlaczego reguła stoi w KODZIE, a nie w prompcie ekstrakcji: „II Turnus Letnich Półkolonii"
 * (dk-pod-lipami, events.json z 2026-08-03) przyszedł ścieżką maszynową z kalendarza `tribe`,
 * czyli z `extract/from-capability.ts`. Żaden model go nie widział i żadne zdanie w prompcie
 * by go nie zatrzymało. Do tego wydarzenia raz wyciągnięte siedzą w cache ekstrakcji
 * (`state.extractions`) i wracają z niego bez pytania modelu, dopóki treść strony się nie
 * zmieni. Odsiew przed scalaniem jest jedynym punktem, przez który przechodzą WSZYSTKIE
 * ścieżki naraz: model, followupy, plakaty, cache, wyjścia maszynowe i wydarzenia FB.
 *
 * Zakres jest wąski celowo: samo słowo „półkolonie", we wszystkich odmianach i bez ogonków.
 * „kolonie", „obóz" i „zimowisko" tu NIE są — „obóz" bywa tytułem wystawy, a „Kolonia"
 * nazwą miejscowości, więc każde z nich to osobna decyzja, którą warto podjąć dopiero
 * z konkretnym rekordem w danych.
 */
import { RUN_SCOPE, auditFor } from "../shared/audit.js";
import type { EventItem } from "../types/index.js";

/**
 * „półkolonie", „Półkolonii", „polkolonia", „półkoloni" — jeden rdzeń załatwia odmianę,
 * a klasy znaków obie pisownie (źródła gubią ogonki, zwłaszcza w tagach i slugach).
 */
const CAMP = /p[oó][łl]koloni/i;

/** Tytuł, kontener i tagi — trzy miejsca, w których nazwa turnusu naprawdę występuje. */
export const isCamp = (ev: EventItem): boolean =>
  CAMP.test(ev.title) || CAMP.test(ev.container) || ev.tags.some((t) => CAMP.test(t));

/**
 * Odsiew tuż przed scalaniem duplikatów.
 *
 * Ślad idzie do ŹRÓDŁA, które wydarzenie dało — tam go szuka ktoś, kto pyta „czemu tego
 * nie ma", dokładnie tak samo jak przy przegranych dedupe. Rekord zostaje przy tym
 * w `SourceRun.produced` i w `run.events`: to jest stan sprzed scalania, a odjęcie od
 * niego odsiewu zafałszowałoby odpowiedź na pytanie, co źródło faktycznie wyprodukowało.
 */
export function withoutCamps(events: EventItem[]): EventItem[] {
  const kept = events.filter((ev) => {
    if (!isCamp(ev)) return true;
    auditFor(ev.source_id ?? RUN_SCOPE, "event.dropped",
      `„${ev.title}" — półkolonie to turnus z zapisami, nie wydarzenie do przyjścia`,
      { title: ev.title, date: ev.date_start, why: "półkolonie" });
    return false;
  });
  const dropped = events.length - kept.length;
  if (dropped) {
    auditFor(RUN_SCOPE, "event.dropped", `odsiew półkolonii: ${dropped} wpisów nie idzie do publikacji`,
      { dropped, kept: kept.length });
  }
  return kept;
}
