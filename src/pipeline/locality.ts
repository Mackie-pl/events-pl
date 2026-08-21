/**
 * LOKALNOŚĆ: czy to wydarzenie w ogóle dzieje się u nas.
 *
 * Serwis obiecuje rzeczy, na które da się PRZYJŚĆ (patrz non-events.ts) — a przyjść da się
 * tylko tam, gdzie się jest. Wycieczka „WAKACJE W TURCJI | ALANYA | SAMOLOT" spełnia każdy
 * inny warunek wydarzenia: ma datę, cenę, zapisy i można w niej wziąć udział. Model słusznie
 * nie oznacza jej jako szum, a żadne zdanie w prompcie tego nie zmieni, bo to nie jest
 * pomyłka klasyfikacji — to inna oś.
 *
 * REGUŁA, nie lista adresów. Gdyby kiedyś Sosnowiec wszedł w zasięg serwisu, wydarzenia
 * z Sosnowca przyszłyby ze stron Sosnowca; ogłoszenie sprzedające sosnowiecki wyjazd na
 * tablicy w Mosinie jest ofertą handlową, a nie relacją z naszego terenu. Dlatego pytamy
 * o GEOGRAFIĘ zamiast blokować domeny: w przyszłym roku będzie 99 innych biur podróży pod
 * 99 innymi adresami, a ta reguła obejmie je wszystkie, nie znając ani jednego.
 *
 * ODSIEWAMY `far` I `abroad` NA RÓWNI, bo dla czytelnika znaczą to samo: nie da się tam
 * przyjść. Wieś Szkocja w gminie Szubin (200 km) i Szkocja z folderu biura podróży są dla
 * digestu tym samym wpisem. Rozróżnienie zostaje wyłącznie w ŚLADZIE — tam odpowiada na
 * pytanie „czy potok się nie pomylił", a to inne pytanie niż „czy to publikować".
 *
 * Podstawą jest pytanie z `probeWhere`, nie zgadywanie z nazwy: Polska ma wsie Turcja,
 * Grecja, Hiszpania, Szkocja, Chiny i Maroko, więc żadna lista słów tego nie rozstrzygnie —
 * rozstrzyga PROSTOKĄT. Zmierzone 2026-08-21 na events.json: 30 z 31 naszych miejscowości
 * znajduje się w prostokącie regionu, 21 z 23 destynacji wyjazdowych — nie.
 *
 * Nie znamy odpowiedzi → nie kasujemy (`unknown`). Fałszywe „to nie nasze" jest niewidoczne,
 * bo skasowanego wydarzenia nikt w digeście nie szuka.
 */
import { RUN_SCOPE, auditFor } from "../shared/audit.js";
import type { EventItem } from "../types/index.js";

/**
 * Odsiew tuż obok `withoutNonEvents` — ta sama zasada: ślad idzie do ŹRÓDŁA, które
 * wydarzenie dało, bo tam go szuka ktoś, kto pyta „czemu tego nie ma".
 */
export function withinRegion(events: EventItem[]): EventItem[] {
  let abroad = 0;
  const kept = events.filter((ev) => {
    if (ev.locality !== "far" && ev.locality !== "abroad") return true;
    if (ev.locality === "abroad") abroad += 1;
    auditFor(ev.source_id ?? RUN_SCOPE, "event.dropped",
      `„${ev.title}" — miejscowości „${ev.town}" nie ma w naszym regionie`
      + (ev.locality === "abroad" ? ": to wyjazd za granicę" : ", tylko gdzie indziej w Polsce"),
      { title: ev.title, date: ev.date_start, town: ev.town, why: "poza regionem" });
    return false;
  });
  const dropped = events.length - kept.length;
  // rozbicie na „zagranica" i „inna część Polski" zostaje, bo pilnuje INNEJ rzeczy niż suma:
  // nagły skok tego drugiego znaczy, że prostokąt regionu przestał pasować do rejestru
  if (dropped) {
    auditFor(RUN_SCOPE, "event.dropped",
      `odsiew po lokalności: ${dropped} wpisów spoza regionu nie idzie do publikacji `
      + `(${abroad} zza granicy, ${dropped - abroad} z dalszej Polski)`,
      { dropped, abroad, kept: kept.length });
  }
  return kept;
}
