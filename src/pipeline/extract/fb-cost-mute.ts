/**
 * Próg opłacalności grup FB: wyciszanie źródeł, które kosztują więcej, niż są warte.
 *
 * Miara jest marginalna, nie brutto. „Ile wydarzeń dała ta grupa" nie odpowiada na pytanie
 * o jej wartość — poznańskie grupy powtarzają w większości to, co i tak stoi na stronach
 * domów kultury. Liczy się `novel`: wydarzenia, których NIE dało żadne źródło spoza FB.
 * Stąd `usdPerNovel = costUsd / novel` jako jedyna liczba, którą warto porównywać z progiem.
 *
 * Dlaczego to nie jest to samo, co zdejmowanie najdroższych po kolei (`simulate()` w
 * reporting/source-yield.ts): tamto odpowiada „którą JEDNĄ grupę mogę zdjąć za darmo",
 * i po każdym zdjęciu liczy od nowa. To odpowiada „czy ten kanał w ogóle zarabia na siebie
 * przy mojej wycenie wydarzenia" — i jest progiem, który da się postawić raz i zostawić.
 *
 * TRZY BEZPIECZNIKI, bo pomyłka tutaj kasuje źródło, nie tylko wiersz w raporcie:
 *   1. bez `FB_MAX_USD_PER_EVENT` mechanizm w ogóle nie działa. Domyślnie WYŁĄCZONY —
 *      wycena wydarzenia jest decyzją właściciela projektu, nie stałą w kodzie,
 *   2. `FB_YIELD_MIN_RUNS` pobrań, zanim cokolwiek zapadnie. Okno runs.json to 7 dni,
 *      a pojedynczy dzień to głównie pogoda i przypadek: 2026-08-11 jedna grupa dała
 *      51 wydarzeń, sąsiednia z tej samej gminy — jedno,
 *   3. wyciszenie WYGASA po `FB_MUTE_DAYS` i źródło wraca samo do pomiaru. Bez tego
 *      pierwszy chudy tydzień byłby wyrokiem dożywotnim, a sezon imprez trwa cały rok.
 *
 * Progi (wartości domyślne i pełny opis: src/config/params.ts):
 *   FB_MAX_USD_PER_EVENT, FB_YIELD_MIN_RUNS, FB_MUTE_DAYS, FB_MIN_SOURCES_PER_TOWN
 */
import { P } from "../../config/index.js";
import { addDays } from "../../shared/dates.js";
import { audit, auditFor } from "../../shared/audit.js";
import type { SourceYield } from "../../reporting/source-yield.js";
import type { FbValueRow, PipelineState, Source } from "../../types/index.js";

import { blockedLimit } from "./fb-group-blocked.js";

/** `null` = próg nieustawiony, czyli mechanizm nie działa. */
export const maxUsdPerEvent = (): number | null => P.FB_MAX_USD_PER_EVENT.get();

export const minRuns = (): number => P.FB_YIELD_MIN_RUNS.get();
export const muteDays = (): number => P.FB_MUTE_DAYS.get();

/**
 * Ile grup FB musi zostać w gminie, choćby były powyżej progu. Domyślnie 1: żadna gmina
 * nie może stracić całej obecności na FB przez sam rachunek. `0` wyłącza podłogę.
 */
export const minPerTown = (): number => P.FB_MIN_SOURCES_PER_TOWN.get();

export type MuteEntry = NonNullable<PipelineState["fbMuted"]>[string];

/** Czy pomijać to źródło w tym przebiegu. `null` = pobieramy (także w dniu wygaśnięcia). */
export function mutedSkip(
  src: Source, state: PipelineState, today: string,
): MuteEntry | null {
  const entry = state.fbMuted?.[src.id];
  if (!entry) return null;
  if (today >= entry.until) return null; // wygasło — wraca do pomiaru
  return entry;
}

/**
 * Werdykt dla jednego źródła FB. Wydzielone, bo to jest CAŁA reguła — reszta modułu
 * tylko ją zapisuje i opowiada.
 *
 * `novel === 0` przy spełnionym minimum pobrań jest przypadkiem osobnym i celowo
 * traktowanym jak przekroczenie progu: „zero nowych wydarzeń za jakiekolwiek pieniądze"
 * to najgorszy możliwy stosunek, a nie brak danych. Dlatego `usdPerNovel` zostaje
 * nieokreślone, a werdykt i tak brzmi „wyciszyć".
 */
export function verdictFor(row: SourceYield, threshold: number | null): FbValueRow["verdict"] {
  if (threshold === null) return "no-threshold";
  if (row.fetchedRuns < minRuns()) return "too-few-runs";
  if (!row.novel) return "muted";
  return (row.usdPerNovel ?? 0) > threshold ? "muted" : "keep";
}

interface Judged {
  row: SourceYield;
  verdict: FbValueRow["verdict"];
  /** grupa niedostępna dla scrapera — nie obsadza gminy i nie ma sensu jej ratować */
  blocked: boolean;
}

/** Werdykty wstępne, jeszcze bez podłogi gminnej. */
function judge(
  sources: readonly SourceYield[], state: PipelineState, threshold: number | null,
): Judged[] {
  const limit = blockedLimit();
  const out: Judged[] = [];
  for (const s of sources) {
    if (s.channel !== "fb") continue;
    // Wyciszać wolno WYŁĄCZNIE grupy. Kanał FB obejmuje też fanpage'e (pomijane osobno)
    // i zbiorczy wiersz `fb-events`, który nie jest źródłem z rejestru, tylko rozwiązywaniem
    // linków zebranych ze WSZYSTKICH źródeł — jego „zero nowych wydarzeń" znaczy „nikt dziś
    // nie wkleił linku do wydarzenia", a nie „to źródło się nie opłaca". Wyciszenie go
    // wyłączyłoby rozwiązywanie wydarzeń FB w całym potoku.
    const mutable = s.fetch === "fb_group";
    const b = state.fbGroupBlocked?.[s.id];
    out.push({
      row: s,
      verdict: mutable ? verdictFor(s, threshold) : "no-threshold",
      blocked: (b?.runs ?? 0) >= limit,
    });
  }
  return out;
}

/**
 * PODŁOGA OBSADY GMINY — ratuje źródła powyżej progu, gdy inaczej gmina zostałaby bez ani
 * jednej grupy FB.
 *
 * Bez tego próg czysto kosztowy jest z góry stronniczy geograficznie, i to nie przez jakość
 * źródeł, tylko przez arytmetykę: ten sam koszt rekordów dzieli się w gminie wiejskiej przez
 * kilka wydarzeń, a w Poznaniu przez pięćdziesiąt. Pomiar 2026-08-12 układa ranking dokładnie
 * wzdłuż tej granicy — najtańsze $0.0023…$0.0026 to wyłącznie grupy poznańskie, najdroższe
 * $0.04…$0.09 to wyłącznie Puszczykowo, Luboń i Dopiewo. Próg zdjąłby więc najpierw te gminy,
 * dla których ten serwis w ogóle powstał, i zrobiłby z niego agregator samego Poznania.
 *
 * Ratujemy od NAJTAŃSZYCH: skoro gmina ma zostać przy jednym źródle, niech to będzie to,
 * które daje najwięcej nowych wydarzeń za złotówkę.
 *
 * Grupy niedostępne dla scrapera nie obsadzają gminy (nie oddają treści) i nie są ratowane
 * (ratowanie nie przywróciłoby im dostępu) — inaczej jedna prywatna grupa „zajmowałaby"
 * miejsce w gminie i pozwalała wyciszyć jedyną działającą.
 */
function applyTownFloor(judged: Judged[]): void {
  const floor = minPerTown();
  if (floor <= 0) return;

  const byTown = new Map<string, Judged[]>();
  for (const j of judged) {
    if (j.row.fetch !== "fb_group" || j.blocked) continue;
    const list = byTown.get(j.row.town);
    if (list) list.push(j); else byTown.set(j.row.town, [j]);
  }

  for (const [town, list] of byTown) {
    let alive = list.filter((j) => j.verdict !== "muted").length;
    if (alive >= floor) continue;
    const rescuable = list
      .filter((j) => j.verdict === "muted")
      .sort((a, b) => (a.row.usdPerNovel ?? Infinity) - (b.row.usdPerNovel ?? Infinity));
    for (const j of rescuable) {
      if (alive >= floor) break;
      j.verdict = "town-floor";
      alive += 1;
      auditFor(j.row.id, "fb.value",
        `powyżej progu, ale ${town} zostałoby bez ani jednej grupy FB — zostaje `
        + `(podłoga ${floor} na gminę, najtańsze z pozostałych: `
        + `${j.row.usdPerNovel === undefined ? "brak nowych wydarzeń" : `$${j.row.usdPerNovel.toFixed(4)}/wyd.`})`,
        { town, floor, usdPerNovel: j.row.usdPerNovel ?? null });
    }
  }
}

const toRow = (j: Judged): FbValueRow => ({
  id: j.row.id,
  fetchedRuns: j.row.fetchedRuns,
  distinct: j.row.distinct,
  novel: j.row.novel ?? 0,
  exclusive: j.row.exclusive,
  costUsd: Number(j.row.costUsd.toFixed(4)),
  ...(j.row.usdPerNovel === undefined ? {} : { usdPerNovel: Number(j.row.usdPerNovel.toFixed(4)) }),
  verdict: j.verdict,
});

/** Zapis werdyktu w stanie. Wyciszenie zakłada się raz; „zostaje" zdejmuje je od razu. */
function persist(
  j: Judged, reg: NonNullable<PipelineState["fbMuted"]>, threshold: number | null, today: string,
): void {
  const s = j.row;
  if (j.verdict === "muted") {
    if (reg[s.id]) return; // już wyciszone — termin liczy się od PIERWSZEGO werdyktu
    const until = addDays(today, muteDays());
    reg[s.id] = {
      since: today, until,
      novel: s.novel ?? 0,
      costUsd: Number(s.costUsd.toFixed(4)),
      ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: Number(s.usdPerNovel.toFixed(4)) }),
    };
    auditFor(s.id, "fb.value", muteNote(s, threshold, until),
      { novel: s.novel ?? 0, costUsd: s.costUsd, until });
    return;
  }
  if ((j.verdict === "keep" || j.verdict === "town-floor") && reg[s.id]) {
    // źródło poprawiło się albo ratuje je podłoga gminna — nie ma na co czekać do `until`
    auditFor(s.id, "fb.value",
      j.verdict === "keep"
        ? `wróciło pod próg ($${s.usdPerNovel?.toFixed(4)} za wydarzenie spoza sieci) — wyciszenie zdjęte`
        : "wyciszenie zdjęte przez podłogę obsady gminy",
      { novel: s.novel ?? 0, usdPerNovel: s.usdPerNovel ?? null });
    delete reg[s.id];
  }
}

/**
 * Przelicza wartość kanału FB w oknie i zapisuje wyciszenia w stanie.
 * Zwraca wiersze do raportu przebiegu — także dla źródeł, których nie ruszono,
 * bo próg bez widocznej podstawy jest nie do sprawdzenia.
 */
export function applyFbMutes(
  sources: readonly SourceYield[], state: PipelineState, today: string,
): FbValueRow[] {
  const threshold = maxUsdPerEvent();
  const reg = (state.fbMuted ??= {});
  const judged = judge(sources, state, threshold);
  // podłoga PRZED zapisem: werdykt „wyciszone", który zaraz cofa podłoga, nie ma prawa
  // trafić ani do stanu, ani do raportu
  applyTownFloor(judged);
  for (const j of judged) persist(j, reg, threshold, today);
  const rows = judged.map(toRow);
  summarise(rows, threshold);
  return rows;
}

function muteNote(s: SourceYield, threshold: number | null, until: string): string {
  const base = `${s.novel ?? 0} wydarzeń spoza sieci z ${s.distinct} przy koszcie $${s.costUsd.toFixed(4)} `
    + `w ${s.fetchedRuns} pobraniach`;
  return s.novel
    ? `${base} → $${s.usdPerNovel?.toFixed(4)} za wydarzenie, próg to $${threshold?.toFixed(4)} `
      + `— wyciszone do ${until}`
    : `${base} → wszystko, co dało, ma już któraś ze stron — wyciszone do ${until}`;
}

/** Jedna linia na przebieg: ile kanał FB kosztuje i ile z tego jest naprawdę nowe. */
function summarise(rows: readonly FbValueRow[], threshold: number | null): void {
  if (!rows.length) return;
  const cost = rows.reduce((n, r) => n + r.costUsd, 0);
  const novel = rows.reduce((n, r) => n + r.novel, 0);
  const muted = rows.filter((r) => r.verdict === "muted").length;
  const floored = rows.filter((r) => r.verdict === "town-floor").length;
  const waiting = rows.filter((r) => r.verdict === "too-few-runs").length;
  const per = novel ? ` ($${(cost / novel).toFixed(4)} za wydarzenie)` : "";
  audit("fb.value",
    `kanał FB w oknie: $${cost.toFixed(4)} za ${novel} wydarzeń, których nie ma żadna strona${per}`
    + (threshold === null
      ? " · próg FB_MAX_USD_PER_EVENT nieustawiony, nikogo nie wyciszamy"
      : ` · próg $${threshold.toFixed(4)}: ${muted} wyciszonych`)
    + (floored ? ` · ${floored} zostaje mimo progu (podłoga ${minPerTown()} na gminę)` : "")
    + (waiting ? ` · ${waiting} czeka na ${minRuns()} pobrań` : ""),
    { costUsd: Number(cost.toFixed(4)), novel, muted, floored, waiting, threshold });
}
