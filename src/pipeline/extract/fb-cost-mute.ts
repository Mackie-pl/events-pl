/**
 * Wyciszanie źródeł FB, które nie mieszczą się w BUDŻECIE kanału.
 *
 * Miara jest marginalna, nie brutto. „Ile wydarzeń dała ta grupa" nie odpowiada na pytanie
 * o jej wartość — poznańskie grupy powtarzają w większości to, co i tak stoi na stronach
 * domów kultury. Liczy się `novel`: wydarzenia, których NIE dało żadne źródło spoza FB.
 * Stąd `usdPerNovel = costUsd / novel` jako jedyna liczba, po której wolno je ustawiać.
 *
 * CO SIĘ ZMIENIŁO 2026-08-17 i dlaczego. Wcześniej decydował tu próg `FB_MAX_USD_PER_EVENT`
 * porównywany ze źródłem po kolei. To nie mogło zadziałać: próg mówi „czy TO źródło jest
 * tanie", a rachunek przychodzi za SUMĘ, więc discovery dokładało tanie źródła w
 * nieskończoność i każde przechodziło próg (pomiar: 15 z 24 grup, $17.3/mies. przy budżecie
 * $15, już z ośmioma wyciszonymi). Teraz kolejność ustala `fb-budget.ts`, a próg jest
 * WYNIKIEM — ceną źródła brzegowego. `FB_MAX_USD_PER_EVENT` zostaje jako opcjonalny twardy
 * sufit „za drogie nawet gdyby się mieściło", nie jako główna reguła.
 *
 * Dlaczego to nie jest to samo, co zdejmowanie najdroższych po kolei (`simulate()` w
 * reporting/source-yield.ts): tamto odpowiada „którą JEDNĄ grupę mogę zdjąć za darmo",
 * i po każdym zdjęciu liczy od nowa. To odpowiada „co się mieści w budżecie".
 *
 * BEZPIECZNIKI, bo pomyłka tutaj kasuje źródło, nie tylko wiersz w raporcie:
 *   1. `FB_YIELD_MIN_RUNS` pobrań, zanim cena źródła cokolwiek znaczy. Okno runs.json to
 *      7 dni, a pojedynczy dzień to głównie pogoda i przypadek: 2026-08-11 jedna grupa dała
 *      51 wydarzeń, sąsiednia z tej samej gminy — jedno. Niezmierzone idą pasem pomiarowym,
 *   2. wyciszenie WYGASA po `FB_MUTE_DAYS` i źródło wraca samo do kolejki. Bez tego
 *      pierwszy chudy tydzień byłby wyrokiem dożywotnim, a sezon imprez trwa cały rok,
 *   3. podłoga obsady gminy (`FB_MIN_SOURCES_PER_TOWN`) — patrz `applyTownFloor`.
 *
 * Progi (wartości domyślne i pełny opis: src/config/params-fb.ts):
 *   FB_PROBATION_SHARE, FB_YIELD_MIN_RUNS, FB_MUTE_DAYS, FB_MIN_SOURCES_PER_TOWN,
 *   FB_MAX_USD_PER_EVENT (opcjonalny sufit), COST_MONTHLY_BUDGET_USD (jedyne pokrętło wydatku)
 */
import { P } from "../../config/index.js";
import { addDays } from "../../shared/dates.js";
import { audit, auditFor } from "../../shared/audit.js";
import type { SourceYield } from "../../reporting/source-yield.js";
import type { FbValueRow, PipelineState, Source } from "../../types/index.js";

import type { BudgetVerdict, Ranked } from "./fb-budget.js";
import { marginalPrice, rankByBudget } from "./fb-budget.js";
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
 * Źródła, o których regulator w ogóle decyduje.
 *
 * `fb-events` jest wyłączony i to nie jest wyjątek per źródło, tylko rozróżnienie rodzaju:
 * to nie pozycja z rejestru, lecz zbiorcze rozwiązywanie linków zebranych ze WSZYSTKICH
 * źródeł. Jego „zero nowych wydarzeń" znaczy „nikt dziś nie wkleił linku", a nie „nie
 * opłaca się" — wyciszenie wyłączyłoby rozwiązywanie wydarzeń FB w całym potoku.
 * Rozstrzyga strategia pobrania, nie identyfikator.
 */
const governed = (s: SourceYield): boolean =>
  s.channel === "fb" && (s.fetch === "fb_group" || s.fetch === "fb");

/**
 * Koszt jednego pobrania — jednostka, w której regulator liczy budżet dzienny.
 *
 * ŹRÓDŁO NIGDY NIE POBIERANE MA KOSZT ZMIERZONY ZERO, a to jest najgorsza możliwa wartość
 * do wstawienia w budżet: pas pomiarowy przyjąłby wtedy KAŻDE z nich, bo darmowe mieści się
 * zawsze. Przy 25 fanpage'ach naraz to 500 rekordów w jedną noc przy budżecie $0.29 —
 * dokładnie ten kształt awarii, który 2026-08-10 kosztował $8. Dlatego dla niepobieranych
 * liczymy SZACUNEK z sufitu limitu: tyle, ile pobranie może kosztować najwyżej.
 */
const usdPerFetch = (s: SourceYield): number => {
  if (s.fetchedRuns > 0) return s.costUsd / s.fetchedRuns;
  const limit = s.fetch === "fb" ? P.PROBE_FB_PAGE_LIMIT.get() : P.FB_GROUP_LIMIT_MAX.get();
  return limit * P.BD_COST_PER_RECORD.get();
};

export const probationShare = (): number => P.FB_PROBATION_SHARE.get();

interface Judged {
  row: SourceYield;
  verdict: FbValueRow["verdict"];
  rank: Ranked | null;
  /** źródło niedostępne dla scrapera — nie obsadza gminy i nie ma sensu go ratować */
  blocked: boolean;
}

/** Werdykt regulatora → werdykt zapisywany w raporcie i w stanie. */
const toVerdict = (v: BudgetVerdict): FbValueRow["verdict"] =>
  v === "in-budget" ? "keep"
    : v === "probation" ? "probation"
      : v === "waiting" ? "too-few-runs"
        : v === "over-ceiling" ? "over-ceiling"
          : "muted";

/** Werdykty wstępne, jeszcze bez podłogi gminnej. */
function judge(
  sources: readonly SourceYield[], state: PipelineState, dailyUsd: number,
): Judged[] {
  const limit = blockedLimit();
  const eligible = sources.filter(governed);
  const ranked = rankByBudget(
    eligible.map((s) => ({
      id: s.id, town: s.town, fetch: s.fetch, fetchedRuns: s.fetchedRuns,
      novel: s.novel ?? 0, usdPerFetch: usdPerFetch(s),
      ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: s.usdPerNovel }),
    })),
    {
      dailyUsd,
      probationShare: probationShare(),
      minRuns: minRuns(),
      ceilingUsdPerNovel: maxUsdPerEvent(),
    },
  );
  const byId = new Map(ranked.map((r) => [r.id, r]));
  const out: Judged[] = [];
  for (const s of sources) {
    if (s.channel !== "fb") continue;
    const r = byId.get(s.id) ?? null;
    const b = state.fbGroupBlocked?.[s.id];
    out.push({
      row: s,
      verdict: r ? toVerdict(r.verdict) : "no-threshold",
      rank: r,
      blocked: (b?.runs ?? 0) >= limit,
    });
  }
  return out;
}

/**
 * PODŁOGA OBSADY GMINY — ratuje źródła poza linią budżetu, gdy inaczej gmina zostałaby bez
 * ani jednej obecności na FB.
 *
 * Bez tego kolejka wartości jest z góry stronnicza geograficznie, i to nie przez jakość
 * źródeł, tylko przez arytmetykę: ten sam koszt rekordów dzieli się w gminie wiejskiej przez
 * kilka wydarzeń, a w Poznaniu przez pięćdziesiąt. Pomiar 2026-08-12 układa ranking dokładnie
 * wzdłuż tej granicy — najtańsze $0.0023…$0.0026 to wyłącznie grupy poznańskie, najdroższe
 * $0.04…$0.09 to wyłącznie Puszczykowo, Luboń i Dopiewo. Sam budżet zdjąłby więc najpierw te
 * gminy, dla których ten serwis w ogóle powstał, i zrobiłby z niego agregator Poznania.
 *
 * OBSADZA KAŻDE ŹRÓDŁO FB, NIE TYLKO GRUPA (zmiana 2026-08-17). Wcześniej liczyły się tu
 * wyłącznie grupy, więc gmina z żywym fanpage'em instytucji i tak musiała utrzymywać płatną
 * tablicę ogłoszeń — podłoga wymuszała wydatek, który sama miała tylko zabezpieczać. Skoro
 * pomiar pokazał, że fanpage bywa najtańszym źródłem w całym kanale (`cik-poznan-fb`
 * $0.0006/wyd. wobec $0.0092 za tablicę w Puszczykowie), obsada gminy nie ma prawa zależeć
 * od tego, którym scraperem ją pobieramy.
 *
 * Ratujemy od NAJTAŃSZYCH: skoro gmina ma zostać przy jednym źródle, niech to będzie to,
 * które daje najwięcej nowych wydarzeń za złotówkę.
 *
 * Źródła niedostępne dla scrapera nie obsadzają gminy (nie oddają treści) i nie są ratowane
 * (ratowanie nie przywróciłoby im dostępu) — inaczej jedna prywatna grupa „zajmowałaby"
 * miejsce w gminie i pozwalała wyciszyć jedyną działającą.
 */
function applyTownFloor(judged: Judged[]): void {
  const floor = minPerTown();
  if (floor <= 0) return;

  const byTown = new Map<string, Judged[]>();
  for (const j of judged) {
    if (!governed(j.row) || j.blocked) continue;
    const list = byTown.get(j.row.town);
    if (list) list.push(j); else byTown.set(j.row.town, [j]);
  }

  for (const [town, list] of byTown) {
    // „żywe" to także pas pomiarowy: źródło właśnie mierzone obsadza gminę, bo jest pobierane
    let alive = list.filter((j) => j.verdict !== "muted" && j.verdict !== "over-ceiling").length;
    if (alive >= floor) continue;
    const rescuable = list
      .filter((j) => j.verdict === "muted" || j.verdict === "over-ceiling")
      .sort((a, b) => (a.row.usdPerNovel ?? Infinity) - (b.row.usdPerNovel ?? Infinity));
    for (const j of rescuable) {
      if (alive >= floor) break;
      j.verdict = "town-floor";
      alive += 1;
      auditFor(j.row.id, "fb.value",
        `poza budżetem, ale ${town} zostałoby bez ani jednego źródła FB — zostaje `
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
  ...(j.rank?.rank == null ? {} : { rank: j.rank.rank }),
  ...(j.rank ? { cumulativeUsd: j.rank.cumulativeUsd, usdPerFetch: j.rank.usdPerFetch } : {}),
  verdict: j.verdict,
});

/** Werdykty, przy których źródło jest pobierane — czyli nie zakłada się na nim wyciszenia. */
const FETCHING: ReadonlySet<FbValueRow["verdict"]> =
  new Set<FbValueRow["verdict"]>(["keep", "town-floor", "probation"]);

/** Zapis werdyktu w stanie. Wyciszenie zakłada się raz; „zostaje" zdejmuje je od razu. */
function persist(
  j: Judged, reg: NonNullable<PipelineState["fbMuted"]>, marginal: number | null, today: string,
): void {
  const s = j.row;
  if (j.verdict === "muted" || j.verdict === "over-ceiling") {
    if (reg[s.id]) return; // już wyciszone — termin liczy się od PIERWSZEGO werdyktu
    const until = addDays(today, muteDays());
    reg[s.id] = {
      since: today, until,
      novel: s.novel ?? 0,
      costUsd: Number(s.costUsd.toFixed(4)),
      ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: Number(s.usdPerNovel.toFixed(4)) }),
    };
    auditFor(s.id, "fb.value", muteNote(j, marginal, until),
      { novel: s.novel ?? 0, costUsd: s.costUsd, until, rank: j.rank?.rank ?? null });
    return;
  }
  if (FETCHING.has(j.verdict) && reg[s.id]) {
    // źródło zmieściło się w budżecie, ratuje je podłoga albo wróciło na pas pomiarowy —
    // nie ma na co czekać do `until`
    auditFor(s.id, "fb.value",
      j.verdict === "keep"
        ? `zmieściło się w budżecie na pozycji ${j.rank?.rank} `
          + `($${s.usdPerNovel?.toFixed(4)} za wydarzenie spoza sieci) — wyciszenie zdjęte`
        : j.verdict === "town-floor"
          ? "wyciszenie zdjęte przez podłogę obsady gminy"
          : "wraca na pas pomiarowy — wyciszenie zdjęte",
      { novel: s.novel ?? 0, usdPerNovel: s.usdPerNovel ?? null });
    delete reg[s.id];
  }
}

/**
 * Przelicza wartość kanału FB w oknie i zapisuje wyciszenia w stanie.
 * Zwraca wiersze do raportu przebiegu — także dla źródeł, których nie ruszono,
 * bo linia budżetu bez widocznej kolejki jest nie do sprawdzenia.
 *
 * `dailyUsd` przychodzi z zewnątrz (patrz `fbDailyBudget`), bo zależy od tego, ile w tym
 * przebiegu zjadła RESZTA potoku — a tego ten moduł nie ma prawa wiedzieć.
 */
export function applyFbMutes(
  sources: readonly SourceYield[], state: PipelineState, today: string, dailyUsd: number,
): FbValueRow[] {
  const reg = (state.fbMuted ??= {});
  const judged = judge(sources, state, dailyUsd);
  // podłoga PRZED zapisem: werdykt „wyciszone", który zaraz cofa podłoga, nie ma prawa
  // trafić ani do stanu, ani do raportu
  applyTownFloor(judged);
  const marginal = marginalPrice(
    judged.flatMap((j) => (j.rank ? [j.rank] : [])),
  );
  for (const j of judged) persist(j, reg, marginal, today);
  const rows = judged.map(toRow);
  summarise(rows, dailyUsd, marginal);
  return rows;
}

function muteNote(j: Judged, marginal: number | null, until: string): string {
  const s = j.row;
  const base = `${s.novel ?? 0} wydarzeń spoza sieci z ${s.distinct} przy koszcie $${s.costUsd.toFixed(4)} `
    + `w ${s.fetchedRuns} pobraniach`;
  if (!s.novel) return `${base} → wszystko, co dało, ma już któraś ze stron — wyciszone do ${until}`;
  if (j.verdict === "over-ceiling") {
    return `${base} → $${s.usdPerNovel?.toFixed(4)} za wydarzenie, ponad twardym sufitem `
      + `$${maxUsdPerEvent()?.toFixed(4)} — wyciszone do ${until}`;
  }
  return `${base} → $${s.usdPerNovel?.toFixed(4)} za wydarzenie, pozycja ${j.rank?.rank} w kolejce `
    + `wartości nie mieści się w budżecie`
    + (marginal === null ? "" : ` (ostatnie przyjęte: $${marginal.toFixed(4)})`)
    + ` — wyciszone do ${until}`;
}

/** Jedna linia na przebieg: ile kanał FB kosztuje i ile z tego jest naprawdę nowe. */
function summarise(
  rows: readonly FbValueRow[], dailyUsd: number, marginal: number | null,
): void {
  if (!rows.length) return;
  const cost = rows.reduce((n, r) => n + r.costUsd, 0);
  const novel = rows.reduce((n, r) => n + r.novel, 0);
  const count = (v: FbValueRow["verdict"]): number => rows.filter((r) => r.verdict === v).length;
  const kept = count("keep");
  const per = novel ? ` ($${(cost / novel).toFixed(4)} za wydarzenie)` : "";
  audit("fb.budget",
    `kanał FB w oknie: $${cost.toFixed(4)} za ${novel} wydarzeń, których nie ma żadna strona${per}`
    + ` · budżet $${dailyUsd.toFixed(4)}/dobę mieści ${kept} źródeł`
    + (marginal === null
      ? " (kolejka pusta — nic jeszcze nie ma zmierzonej ceny)"
      : `, cena brzegowa $${marginal.toFixed(4)}/wyd.`)
    + (count("muted") ? ` · ${count("muted")} poza budżetem` : "")
    + (count("over-ceiling") ? ` · ${count("over-ceiling")} ponad sufitem $${maxUsdPerEvent()?.toFixed(4)}` : "")
    + (count("probation") ? ` · ${count("probation")} na pasie pomiarowym` : "")
    + (count("town-floor") ? ` · ${count("town-floor")} zostaje mimo budżetu (podłoga ${minPerTown()} na gminę)` : "")
    + (count("too-few-runs") ? ` · ${count("too-few-runs")} czeka na wolne miejsce w pasie` : ""),
    {
      costUsd: Number(cost.toFixed(4)), novel, dailyUsd: Number(dailyUsd.toFixed(4)),
      marginalUsdPerNovel: marginal, kept, muted: count("muted"),
      probation: count("probation"), floored: count("town-floor"),
    });
}
