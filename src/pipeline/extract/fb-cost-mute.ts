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
 * Env:
 *   FB_MAX_USD_PER_EVENT   (brak = wyłączone) próg $ za jedno wydarzenie spoza sieci
 *   FB_YIELD_MIN_RUNS      (opc.) minimum realnych pobrań do werdyktu, domyślnie 5
 *   FB_MUTE_DAYS           (opc.) na ile dni wycisza, domyślnie 30
 */
import { addDays } from "../../shared/dates.js";
import { audit, auditFor } from "../../shared/audit.js";
import type { SourceYield } from "../../reporting/source-yield.js";
import type { FbValueRow, PipelineState, Source } from "../../types/index.js";

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** `null` = próg nieustawiony, czyli mechanizm nie działa. */
export function maxUsdPerEvent(): number | null {
  const raw = process.env["FB_MAX_USD_PER_EVENT"];
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export const minRuns = (): number => num("FB_YIELD_MIN_RUNS", 5);
export const muteDays = (): number => num("FB_MUTE_DAYS", 30);

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
  const rows: FbValueRow[] = [];

  for (const s of sources) {
    if (s.channel !== "fb") continue;
    // Wyciszać wolno WYŁĄCZNIE grupy. Kanał FB obejmuje też fanpage'e (pomijane osobno)
    // i zbiorczy wiersz `fb-events`, który nie jest źródłem z rejestru, tylko rozwiązywaniem
    // linków zebranych ze WSZYSTKICH źródeł — jego „zero nowych wydarzeń" znaczy „nikt dziś
    // nie wkleił linku do wydarzenia", a nie „to źródło się nie opłaca". Wyciszenie go
    // wyłączyłoby rozwiązywanie wydarzeń FB w całym potoku.
    const mutable = s.fetch === "fb_group";
    const verdict = mutable ? verdictFor(s, threshold) : "no-threshold";
    rows.push({
      id: s.id,
      fetchedRuns: s.fetchedRuns,
      distinct: s.distinct,
      novel: s.novel ?? 0,
      exclusive: s.exclusive,
      costUsd: Number(s.costUsd.toFixed(4)),
      ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: Number(s.usdPerNovel.toFixed(4)) }),
      verdict,
    });

    if (verdict === "muted" && !reg[s.id]) {
      const until = addDays(today, muteDays());
      reg[s.id] = {
        since: today, until,
        novel: s.novel ?? 0,
        costUsd: Number(s.costUsd.toFixed(4)),
        ...(s.usdPerNovel === undefined ? {} : { usdPerNovel: Number(s.usdPerNovel.toFixed(4)) }),
      };
      auditFor(s.id, "fb.value", muteNote(s, threshold, until),
        { novel: s.novel ?? 0, costUsd: s.costUsd, until });
    } else if (verdict === "keep" && reg[s.id]) {
      // źródło poprawiło się w oknie, zanim wyciszenie wygasło — nie ma po co czekać
      auditFor(s.id, "fb.value",
        `wróciło pod próg ($${s.usdPerNovel?.toFixed(4)} za wydarzenie spoza sieci) — wyciszenie zdjęte`,
        { novel: s.novel ?? 0, usdPerNovel: s.usdPerNovel ?? null });
      delete reg[s.id];
    }
  }
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
  const waiting = rows.filter((r) => r.verdict === "too-few-runs").length;
  const per = novel ? ` ($${(cost / novel).toFixed(4)} za wydarzenie)` : "";
  audit("fb.value",
    `kanał FB w oknie: $${cost.toFixed(4)} za ${novel} wydarzeń, których nie ma żadna strona${per}`
    + (threshold === null
      ? " · próg FB_MAX_USD_PER_EVENT nieustawiony, nikogo nie wyciszamy"
      : ` · próg $${threshold.toFixed(4)}: ${muted} wyciszonych`)
    + (waiting ? ` · ${waiting} czeka na ${minRuns()} pobrań` : ""),
    { costUsd: Number(cost.toFixed(4)), novel, muted, waiting, threshold });
}
