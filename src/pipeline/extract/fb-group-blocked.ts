/**
 * Grupy FB niedostępne dla scrapera: wykrycie, pomijanie i droga powrotna.
 *
 * Bright Data z `include_errors=true` na grupę prywatną/usuniętą oddaje JEDEN wiersz błędu
 * zamiast postów. Wiersz jest płatny jak każdy inny rekord, a treści nie niesie żadnej —
 * więc taka grupa kosztuje codziennie i nie ma jak nic dać. W przebiegu 2026-08-11 były to
 * trzy z 23 grup (`dopiewo-mieszkancy-fb`, `dabrowa-dopiewo-fb`, `fb-group-mieszkancy-gminy-komorniki`),
 * każda po jednym rekordzie, każda ze statusem „empty" nieodróżnialnym od grupy, która
 * po prostu nie pisze o wydarzeniach.
 *
 * Dlaczego licznik serii, a nie wyłączenie po pierwszym błędzie: pojedynczy wiersz błędu bywa
 * chwilowy (scraper się przewrócił, FB pokazał interstitial). Dowodem jest dopiero seria.
 *
 * Dlaczego pomijanie samo wygasa: grupa zamknięta bywa otwierana z powrotem, a bez sondy
 * nie miałby tego kto zauważyć — wpis w rejestrze zostałby martwy na zawsze i to my byśmy
 * o tym nie wiedzieli. Sonda co `FB_GROUP_BLOCKED_RECHECK_DAYS` kosztuje jeden rekord
 * ($0.0015) i jest jedyną drogą powrotną.
 *
 * Świadomie NIE `Source.inactive`: tamto znaczy „discovery przestało znajdować ten adres",
 * naprawia je wyszukiwarka i dotyczy każdego rodzaju źródła. To znaczy „adres jest, scraper
 * się do niego nie dostaje" — inna diagnoza, inna naprawa, więc inny status.
 *
 * Progi (wartości domyślne i pełny opis: src/config/params.ts):
 *   FB_GROUP_BLOCKED_LIMIT, FB_GROUP_BLOCKED_RECHECK_DAYS
 */
import { P } from "../../config/index.js";
import { addDays } from "../../shared/dates.js";
import { audit } from "../../shared/audit.js";
import type { FbGroupStats, PipelineState, Source } from "../../types/index.js";

export const blockedLimit = (): number => P.FB_GROUP_BLOCKED_LIMIT.get();
export const recheckDays = (): number => P.FB_GROUP_BLOCKED_RECHECK_DAYS.get();

export type BlockedEntry = NonNullable<PipelineState["fbGroupBlocked"]>[string];

/**
 * Czy pominąć to źródło w tym przebiegu. `null` = pobieramy normalnie, w tym w dniu sondy —
 * bo sonda to zwykłe pobranie, którego wynik przejdzie przez `noteFbGroup` jak każdy inny.
 */
export function blockedSkip(
  src: Source, state: PipelineState, today: string,
): BlockedEntry | null {
  if (src.fetch !== "fb_group") return null;
  const entry = state.fbGroupBlocked?.[src.id];
  if (!entry || entry.runs < blockedLimit()) return null;
  if (today >= addDays(entry.lastTry, recheckDays())) return null;
  return entry;
}

/**
 * Zapisuje wynik pobrania grupy w liczniku serii.
 *
 * Trzy przypadki i każdy znaczy co innego:
 *   - jakikolwiek post  → grupa odpowiada, wpis znika (licznik liczy SERIĘ, nie historię),
 *   - same wiersze błędu → seria rośnie,
 *   - zero rekordów      → nie wiemy nic (timeout, awaria BD, anulowana migawka) i dlatego
 *     NIE karzemy: inaczej awaria po stronie dostawcy wyłączałaby nam zdrowe grupy.
 */
export function noteFbGroup(
  id: string, stats: FbGroupStats, state: PipelineState, today: string,
): void {
  const reg = (state.fbGroupBlocked ??= {});
  if (stats.posts > 0) {
    if (reg[id]) {
      audit("fb.group", `grupa znowu oddaje posty po ${reg[id].runs} pobraniach z samym błędem — licznik wyzerowany`,
        { was: reg[id].runs, since: reg[id].since });
      delete reg[id];
    }
    return;
  }
  if (!stats.errorRows) return;

  const prev = reg[id];
  const entry: BlockedEntry = {
    runs: (prev?.runs ?? 0) + 1,
    since: prev?.since ?? today,
    lastTry: today,
    ...(stats.blockedWhy ? { why: stats.blockedWhy } : {}),
  };
  reg[id] = entry;
  audit("fb.group", blockedNote(entry),
    { runs: entry.runs, limit: blockedLimit(), since: entry.since, records: stats.records });
}

/** Werdykt serii słowami: czy to już wyłączenie, czy jeszcze pobieramy. */
function blockedNote(entry: BlockedEntry): string {
  const limit = blockedLimit();
  const why = entry.why ? `: „${entry.why}”` : " (scraper nie podał powodu)";
  if (entry.runs >= limit) {
    return `${entry.runs}. pobranie z rzędu bez ani jednego postu${why} — `
      + `od następnego przebiegu pomijamy, sonda co ${recheckDays()} dni`;
  }
  return `pobranie bez ani jednego postu${why} — ${entry.runs}/${limit} z rzędu, `
    + "jeszcze pobieramy (pojedynczy błąd bywa chwilowy)";
}
