/**
 * Plon marginalny źródeł: co byśmy STRACILI, zdejmując dane źródło z rejestru.
 *
 * Rejestr rośnie monotonicznie — discovery dokłada, nic nie odejmuje poza adresami, które
 * padły. Dla jednej 30-tysięcznej gminy potrafi to dać pięć grup FB opisujących w większości
 * te same imprezy, a każda kosztuje osobno (rekordy Bright Data + wywołania modelu).
 * „Ile wydarzeń dało źródło" nie odpowiada na pytanie o jego wartość: liczy się, ile dało
 * wydarzeń, których NIE dało nic innego.
 *
 * Wszystko liczy się z zapisanego `runs.json` — zero sieci, zero kosztu. Nośnikiem jest
 * `SourceRun.produced` (stan PRZED dedupe), bo tylko tam widać rekordy przegranych; po
 * scaleniu duplikat po prostu znika i nie da się odróżnić „nikt inny tego nie miał"
 * od „wszyscy to mieli".
 *
 * Uwaga na horyzont: „wyłączne" znaczy „w tym oknie nikt inny tego nie dał". Źródło, które
 * publikuje jako pierwsze, a resztę i tak dopisują inni, wyjdzie tu na zbędne — bo w skali
 * okna nim jest. Utrata WYPRZEDZENIA jest realna i tego ten raport nie mierzy.
 */
import { eventKey } from "../shared/event-key.js";
import type { CostRates, RunReport } from "../types/index.js";

/** Rachunek jednego źródła w oknie przebiegów. */
export interface SourceYield {
  id: string;
  name: string;
  town: string;
  /** przebiegi, w których źródło w ogóle wystąpiło (także jako pominięte) */
  runs: number;
  /** wydarzenia oddane przez źródło, sumarycznie przez całe okno (przed dedupe) */
  produced: number;
  /** różne wydarzenia (klucze) — powtórzenia tego samego dzień po dniu liczą się raz */
  distinct: number;
  /** wydarzenia, których NIE dało żadne inne źródło — to jest cała stawka przy usuwaniu */
  exclusive: number;
  /** wydarzenia, które ma też ktoś inny */
  shared: number;
  llmUsd: number;
  bdRecords: number;
  costUsd: number;
  /** najczęstszy status źródła w oknie — odróżnia „pomijane" od „pobrane i puste" */
  status: string;
  /** z kim się pokrywa, od najczęstszego — pokazuje PARY do rozstrzygnięcia */
  overlaps: Array<{ id: string; keys: number }>;
}

/**
 * Jeden krok symulacji „zdejmuj od najdroższego".
 *
 * `reason` istnieje, bo bez niego raport odpowiada na dwa pytania naraz i myli je ze sobą.
 * Źródło jałowe (nic nie dało) i redundantne (dało, ale wszystko ma ktoś inny) są w symulacji
 * nieodróżnialne — oba zdejmuje się bez straty — a to zupełnie różne diagnozy: pierwsze
 * zwykle znaczy zepsutą ekstrakcję do naprawy, drugie faktyczny nadmiar w rejestrze.
 */
export interface DropStep {
  id: string;
  costUsd: number;
  dropped: boolean;
  reason: "barren" | "redundant" | "keep";
  /** dominujący status w oknie — dla jałowych mówi, CZY w ogóle było co ekstrahować */
  status: string;
  /** ile wydarzeń zniknęłoby z events.json, gdyby zdjąć to źródło TERAZ (0 = można zdjąć) */
  wouldLose: number;
}

export interface YieldReport {
  /** przebiegi wzięte do rachunku */
  runs: number;
  from: string;
  to: string;
  /** przebiegi pominięte, bo są sprzed pola `produced` — inaczej zaniżyłyby plon każdego źródła */
  skippedRuns: string[];
  distinctEvents: number;
  sources: SourceYield[];
  steps: DropStep[];
  /** ile dałoby się przestać wydawać, nie tracąc ANI JEDNEGO wydarzenia */
  savedUsd: number;
}

interface Acc {
  meta: { id: string; name: string; town: string };
  runs: number;
  produced: number;
  keys: Set<string>;
  llmUsd: number;
  bdRecords: number;
  statuses: Map<string, number>;
}

/** Najczęstszy status w oknie; przy remisie ten, który wystąpił pierwszy. */
const dominant = (statuses: Map<string, number>): string =>
  [...statuses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

/**
 * Przebieg sprzed wprowadzenia `produced` wygląda identycznie jak przebieg, w którym nic nie
 * spłonęło: w obu żadne źródło nie ma tego pola. Rozstrzyga suma — skoro wydarzenia były,
 * a przypisania nie ma, to stary format. Wciągnięcie go pokazałoby każde źródło jako jałowe.
 */
const hasAttribution = (run: RunReport): boolean =>
  run.totals.events === 0 || run.sources.some((s) => s.produced?.length);

/** Kto dał to wydarzenie: klucz → zbiór id źródeł, w całym oknie. */
function collect(runs: RunReport[]): {
  producers: Map<string, Set<string>>;
  acc: Map<string, Acc>;
} {
  const producers = new Map<string, Set<string>>();
  const acc = new Map<string, Acc>();

  for (const run of runs) {
    for (const s of run.sources) {
      let a = acc.get(s.id);
      if (!a) {
        a = {
          meta: { id: s.id, name: s.name, town: s.town },
          runs: 0, produced: 0, keys: new Set(), llmUsd: 0, bdRecords: 0, statuses: new Map(),
        };
        acc.set(s.id, a);
      }
      a.runs++;
      a.llmUsd += s.llm.costUsd;
      a.bdRecords += s.bd?.records ?? 0;
      a.statuses.set(s.status, (a.statuses.get(s.status) ?? 0) + 1);

      for (const ref of s.produced ?? []) {
        const key = eventKey(ref.title, ref.date);
        a.produced++;
        a.keys.add(key);
        let set = producers.get(key);
        if (!set) { set = new Set(); producers.set(key, set); }
        set.add(s.id);
      }
    }
  }
  return { producers, acc };
}

/** Z kim dane źródło dzieli wydarzenia, od najczęstszego. */
function overlapsOf(id: string, keys: Set<string>, producers: Map<string, Set<string>>): SourceYield["overlaps"] {
  const tally = new Map<string, number>();
  for (const key of keys) {
    for (const other of producers.get(key) ?? []) {
      if (other !== id) tally.set(other, (tally.get(other) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([other, n]) => ({ id: other, keys: n }))
    .sort((a, b) => b.keys - a.keys);
}

/**
 * Symulacja „zdejmuj od najdroższego". Zdejmujemy tylko wtedy, gdy ŻADNE wydarzenie nie
 * zostanie bez dostawcy — i po każdym zdjęciu liczymy od nowa, bo dwa źródła trzymające
 * to samo wydarzenie są zbędne pojedynczo, ale nie razem: pierwsze zdejmiemy za darmo,
 * drugie stanie się wtedy jedynym dostawcą i musi zostać.
 */
function simulate(sources: SourceYield[], producers: Map<string, Set<string>>): {
  steps: DropStep[]; savedUsd: number;
} {
  const alive = new Map<string, Set<string>>();
  for (const [key, set] of producers) alive.set(key, new Set(set));

  const steps: DropStep[] = [];
  let savedUsd = 0;

  for (const s of [...sources].sort((a, b) => b.costUsd - a.costUsd)) {
    let wouldLose = 0;
    for (const set of alive.values()) if (set.size === 1 && set.has(s.id)) wouldLose++;
    if (wouldLose === 0) {
      for (const set of alive.values()) set.delete(s.id);
      savedUsd += s.costUsd;
    }
    steps.push({
      id: s.id,
      costUsd: s.costUsd,
      status: s.status,
      dropped: wouldLose === 0,
      reason: wouldLose > 0 ? "keep" : s.distinct === 0 ? "barren" : "redundant",
      wouldLose,
    });
  }
  return { steps, savedUsd };
}

export function buildYield(allRuns: readonly RunReport[], rates: CostRates): YieldReport {
  const daily = allRuns.filter((r) => r.stage === "daily");
  const runs = daily.filter(hasAttribution);
  const skippedRuns = daily.filter((r) => !hasAttribution(r)).map((r) => r.startedAt.slice(0, 10));

  const { producers, acc } = collect(runs);

  const sources: SourceYield[] = [...acc.values()].map((a) => {
    let exclusive = 0;
    for (const key of a.keys) if ((producers.get(key)?.size ?? 0) === 1) exclusive++;
    return {
      ...a.meta,
      runs: a.runs,
      produced: a.produced,
      distinct: a.keys.size,
      exclusive,
      shared: a.keys.size - exclusive,
      llmUsd: a.llmUsd,
      bdRecords: a.bdRecords,
      costUsd: a.llmUsd + a.bdRecords * rates.bdPerRecord,
      status: dominant(a.statuses),
      overlaps: overlapsOf(a.meta.id, a.keys, producers),
    };
  });

  const { steps, savedUsd } = simulate(sources, producers);
  return {
    runs: runs.length,
    from: runs[0]?.startedAt.slice(0, 10) ?? "—",
    to: runs.at(-1)?.startedAt.slice(0, 10) ?? "—",
    skippedRuns,
    distinctEvents: producers.size,
    sources: sources.sort((a, b) => b.costUsd - a.costUsd || b.exclusive - a.exclusive),
    steps,
    savedUsd,
  };
}
