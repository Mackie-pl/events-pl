/**
 * Ile z rachunku za model poszło na bloki, z których nie wyszło ani jedno wydarzenie.
 *
 * Liczone z `audit.json`, nie z `runs.json`, i to jest tu jedyna nieoczywista decyzja.
 * Raport przebiegu wie o źródle tylko tyle, ile bloków poszło do modelu — a pytanie brzmi,
 * KTÓRE z nich milczały i ile ważyły. Ta wiedza mieszka wyłącznie w śladzie: krok `block`
 * niesie świeże znaki, `block.parsed` jałowe, a wywołanie paczkowe własny rachunek. Ślad
 * ma krótsze okno (~8 przebiegów), ale to okno o tyle wystarczy, że reguły ekstrakcji
 * zmieniają się z dnia na dzień i tydzień wstecz i tak nic nie mówi o dzisiejszym kodzie.
 *
 * Osobno od komponentu, bo to jest cała treść tej zakładki — reszta to tabela i sortowanie.
 */
import type { AuditStep, RunTrail } from '../../types';

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const share = (part: number, whole: number): number => (whole ? part / whole : 0);

/** Rozliczenie jednego źródła w jednym przebiegu. */
export interface RunWaste {
  run: string;
  day: string;
  /** bloki, które poszły do modelu (świeże — reszta wróciła z cache'a za darmo) */
  fresh: number;
  freshChars: number;
  /** z tego: bez ani jednego wydarzenia */
  silent: number;
  silentChars: number;
  /** jałowe, ale wskazały podstronę albo plakat — wydatek, nie strata */
  silentLeads: number;
  /** wydarzenia ze świeżych bloków */
  events: number;
  /** rachunek za wywołania paczkowe tego źródła */
  usd: number;
  /**
   * Ślad tego przebiegu zna ZNAKI jałowych bloków. Przebiegi sprzed wprowadzenia pomiaru
   * mają same sztuki — i muszą być widoczne jako niezmierzone, bo policzone jako zero
   * wyglądałyby dokładnie jak źródło, któremu nic się nie marnuje.
   */
  measured: boolean;
}

export type RunWasteBody = Omit<RunWaste, 'run' | 'day'>;

/** Suma po przebiegach, czyli wiersz tabeli. */
export interface WasteRow extends RunWasteBody {
  id: string;
  runs: RunWaste[];
  /**
   * Świeże znaki z przebiegów OBJĘTYCH POMIAREM — mianownik udziału i jedyny poprawny.
   *
   * `freshChars` liczy wszystko, co poszło do modelu, także przebiegi sprzed pomiaru; dzielenie
   * przez nie zaniżałoby udział o tyle, ile akurat mamy starego śladu w oknie, i to zaniżenie
   * kurczyłoby się samo z dnia na dzień — czyli wykres poprawiałby się bez żadnej poprawki.
   */
  measuredChars: number;
  /** ~$ za jałowe bloki: rachunek przeskalowany udziałem jałowych znaków (patrz `wastedUsdOf`) */
  wastedUsd: number;
  /** przebiegi, w których coś poszło do modelu i NIC nie wróciło */
  barren: number;
  /** przebiegi bez pomiaru znaków — liczą się do sztuk, nie do kwot */
  unmeasured: number;
}

/** Udział jałowej treści — liczony WYŁĄCZNIE na tym, co zmierzone (patrz `measuredChars`). */
export const silentShareOf = (r: WasteRow): number => share(r.silentChars, r.measuredChars);

/**
 * Ślad jednego źródła w jednym przebiegu → liczby.
 *
 * Dwa filtry, które łatwo przeoczyć, a bez nich wiersz kłamie:
 *   `block` bez `freshChars` to NIE jest podział — to odmowa ścieżki blokowej („przebudowa
 *   serwisu") albo przycinanie cache'a. Mówią o blokach, których nikt nie kupił.
 *   `llm` bez `blocks` to wywołanie na całą stronę albo plakat — inna ścieżka, inny rachunek.
 */
export function trailWaste(steps: AuditStep[]): RunWasteBody {
  const w: RunWasteBody = {
    fresh: 0, freshChars: 0, silent: 0, silentChars: 0, silentLeads: 0,
    events: 0, usd: 0, measured: true,
  };
  for (const s of steps) {
    const d = s.detail ?? {};
    if (s.step === 'block' && typeof d['freshChars'] === 'number') {
      w.fresh += n(d['fresh']);
      w.freshChars += d['freshChars'];
    } else if (s.step === 'block.parsed') {
      w.silent += n(d['silent']);
      w.events += n(d['fromFresh']);
      w.silentLeads += n(d['silentLeads']);
      if (typeof d['silentChars'] === 'number') w.silentChars += d['silentChars'];
      else if (n(d['silent']) > 0) w.measured = false;
    } else if (s.step === 'llm' && typeof d['blocks'] === 'number') {
      w.usd += n(d['usd']);
    }
  }
  return w;
}

/**
 * SZACUNEK, nie kwota od dostawcy — i dlatego wszędzie stoi przy nim `~`.
 *
 * Jedno wywołanie obsługuje całą paczkę bloków, więc rachunku nie da się rozciąć po blokach
 * inaczej niż udziałem treści. Zakłada, że znak kosztuje tyle samo niezależnie od tego,
 * w którym bloku stoi, i pomija stały narzut promptu systemowego (~900 tokenów na wywołanie),
 * którego nie odzyskałoby wycięcie nawet wszystkich jałowych bloków. Czyli: zawyża delikatnie,
 * a nie zaniża — na tej stronie to właściwa strona pomyłki.
 */
export const wastedUsdOf = (w: RunWasteBody): number =>
  w.measured ? w.usd * share(w.silentChars, w.freshChars) : 0;

const blank = (id: string): WasteRow => ({
  id, runs: [], fresh: 0, freshChars: 0, silent: 0, silentChars: 0, silentLeads: 0,
  events: 0, usd: 0, measured: true, measuredChars: 0, wastedUsd: 0, barren: 0, unmeasured: 0,
});

function add(row: WasteRow, w: RunWaste): void {
  row.runs.push(w);
  row.fresh += w.fresh;
  row.freshChars += w.freshChars;
  row.silent += w.silent;
  row.silentChars += w.silentChars;
  row.silentLeads += w.silentLeads;
  row.events += w.events;
  row.usd += w.usd;
  row.wastedUsd += wastedUsdOf(w);
  if (!w.events) row.barren += 1;
  if (w.measured) row.measuredChars += w.freshChars;
  else {
    row.unmeasured += 1;
    row.measured = false;
  }
}

/**
 * Wiersze po źródłach. Źródło, które w danym przebiegu nic nie kupiło (wszystko z cache'a,
 * feed maszynowy, pominięcie), w tym przebiegu się nie pojawia — nie ma czego marnować,
 * a wliczone jako „przebieg bez strat" rozwadniałoby każdy udział w tabeli.
 */
export function aggregateWaste(trails: RunTrail[]): WasteRow[] {
  const by = new Map<string, WasteRow>();
  for (const t of trails) {
    for (const src of t.sources) {
      const w = trailWaste(src.steps);
      if (!w.fresh) continue;
      const row = by.get(src.id) ?? blank(src.id);
      add(row, { run: t.run, day: t.day, ...w });
      by.set(src.id, row);
    }
  }
  return [...by.values()];
}

/**
 * Źródła, w których model NIGDY nie znalazł nic w tym oknie, a mimo to co przebieg
 * dostawał świeżą treść. To nie jest „strona nic nie ma": strona się rusza (inaczej cache
 * trafiałby i nie byłoby świeżych bloków), tylko rusza się nie w wydarzeniach. Zwykle
 * znaczy, że discovery wskazało niewłaściwą podstronę — ta sama diagnoza, co `chronic`
 * na zakładce Yield, tyle że widoczna już po jednym przebiegu z blokami.
 */
export const chronicOf = (rows: WasteRow[]): WasteRow[] =>
  rows.filter((r) => r.runs.length >= 2 && r.events === 0 && r.usd > 0);
