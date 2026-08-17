/**
 * REGULATOR BUDŻETU KANAŁU FB — kto się mieści, a nie kto jest tani.
 *
 * DLACZEGO PRÓG CENOWY NIE WYSTARCZAŁ. `FB_MAX_USD_PER_EVENT` odpowiada na pytanie „czy to
 * źródło jest tanie", a rachunek przychodzi za SUMĘ. To dwie różne wielkości i próg nie ma
 * jak ich pogodzić: discovery dokłada źródła monotonicznie, każde nowe przechodzi próg, a
 * całość rośnie bez ograniczenia. Pomiar 2026-08-17: próg $0.02 przepuszcza 15 z 24 grup,
 * realny wydatek to $17.3/mies. przy budżecie $15 — i to JUŻ z ośmioma wyciszonymi.
 * Cztery najtańsze źródła w całym kanale (fanpage'e, $0.0006–$0.0047) nie mieściły się
 * w budżecie tylko dlatego, że płacimy za tablice ogłoszeń po $0.0092.
 *
 * Własność perwersyjna, którą to usuwa: przy progu cenowym KAŻDE dobre znalezisko pogarsza
 * budżet. Przy regulatorze budżetowym tanie źródło WYPYCHA droższe — znalezienie
 * `cik-poznan-fb` zmniejsza to, co płacimy za `puszczykowo-ogloszenia-fb`, zamiast dokładać.
 *
 * JAK TO DZIAŁA. Wszystkie źródła FB (grupy i fanpage'e — jeden kanał, jedna kolejka)
 * ustawiamy rosnąco po zmierzonej cenie `usdPerNovel` i przyjmujemy zachłannie, aż wyczerpie
 * się dzienny budżet. Próg przestaje być pokrętłem i staje się WYNIKIEM: ceną źródła
 * brzegowego ($0.0051 w pomiarze wyżej). Jedynym pokrętłem zostaje budżet.
 *
 * PAS POMIAROWY (`FB_PROBATION_SHARE`). Ranking potrafi ustawić tylko źródła, które już coś
 * dały. Nowe z discovery nie mają ceny i bez osobnego, ograniczonego pasa nigdy by jej nie
 * zdobyły — kanał zamarłby na dzisiejszym składzie, co jest dokładnie tym „raz zapadło, na
 * zawsze", którego nie chcemy. Pas bierze najstarsze niezmierzone najpierw.
 *
 * REGULATOR MOŻE WYDATEK WYŁĄCZNIE ZMNIEJSZAĆ. Nie podnosi limitów u dostawcy, nie dokłada
 * pobrań ponad budżet i nie zna ścieżki „dokup jeszcze trochę". Przy budżecie ≤ 0 przyjmuje
 * zero źródeł. To ta sama zasada, która po awarii 2026-08-10 trzyma sufit `limit_per_input`.
 */
import type { SourceYield } from "../../reporting/source-yield.js";

/** Wiersz wejściowy — tyle regulator potrzebuje wiedzieć o źródle. */
export interface BudgetInput {
  id: string;
  town: string;
  fetch: SourceYield["fetch"];
  fetchedRuns: number;
  novel: number;
  /** koszt JEDNEGO pobrania — to jest jednostka, w której liczy się budżet dzienny */
  usdPerFetch: number;
  usdPerNovel?: number;
}

export type BudgetVerdict =
  /** mieści się w budżecie — pobieramy */
  | "in-budget"
  /** zmierzone, ale poza linią budżetu — wyciszamy do czasu, aż stanieje albo zwolni się miejsce */
  | "over-budget"
  /** ponad twardym sufitem `FB_MAX_USD_PER_EVENT`, niezależnie od budżetu */
  | "over-ceiling"
  /** niezmierzone, pobierane z pasa pomiarowego */
  | "probation"
  /** niezmierzone i pas się skończył — czeka na kolejny przebieg */
  | "waiting";

export interface Ranked {
  id: string;
  verdict: BudgetVerdict;
  /** pozycja w kolejce wartości; `null` dla niezmierzonych */
  rank: number | null;
  usdPerFetch: number;
  usdPerNovel?: number;
  /** ile budżetu zjada wszystko do tego miejsca włącznie — czyni linię cięcia sprawdzalną */
  cumulativeUsd: number;
}

export interface BudgetOpts {
  /** dzienny budżet kanału FB w USD (już po odjęciu tego, co zjada reszta potoku) */
  dailyUsd: number;
  /** ułamek budżetu odłożony na pomiar niezmierzonych */
  probationShare: number;
  /** minimum pobrań, zanim cena źródła jest wiarygodna */
  minRuns: number;
  /** twardy sufit ceny; `null` = brak sufitu, decyduje sam budżet */
  ceilingUsdPerNovel: number | null;
}

/**
 * Czy cena tego źródła jest już wiarygodna. `novel === 0` przy spełnionym minimum NIE jest
 * brakiem pomiaru, tylko najgorszym możliwym wynikiem — źródło idzie do rankingu z ceną
 * nieskończoną i wypada poniżej linii. Inaczej jałowe źródło wracałoby w pas pomiarowy
 * w kółko i płaciłoby za siebie w nieskończoność.
 */
const measured = (r: BudgetInput, minRuns: number): boolean => r.fetchedRuns >= minRuns;

const priceOf = (r: BudgetInput): number => r.usdPerNovel ?? Infinity;

/**
 * Kolejka wartości + linia budżetu. Zwraca wiersze W KOLEJNOŚCI RANKINGU, żeby raport mógł
 * pokazać dokładnie to, czym kierowała się decyzja — bez tego „wyciszono osiem źródeł" jest
 * twierdzeniem nie do sprawdzenia.
 */
export function rankByBudget(rows: readonly BudgetInput[], opts: BudgetOpts): Ranked[] {
  const budget = Math.max(0, opts.dailyUsd);
  const probationBudget = budget * Math.max(0, opts.probationShare);
  const valueBudget = budget - probationBudget;

  const meas = rows.filter((r) => measured(r, opts.minRuns))
    .sort((a, b) => priceOf(a) - priceOf(b) || a.id.localeCompare(b.id));
  // niezmierzone: najpierw te, które były pobierane NAJRZADZIEJ — inaczej jedno źródło
  // mogłoby zająć pas na stałe, a reszta nigdy nie dostałaby swojej pierwszej ceny
  const fresh = rows.filter((r) => !measured(r, opts.minRuns))
    .sort((a, b) => a.fetchedRuns - b.fetchedRuns || a.id.localeCompare(b.id));

  const out: Ranked[] = [];
  let cum = 0;
  meas.forEach((r, i) => {
    const price = priceOf(r);
    const overCeiling = opts.ceilingUsdPerNovel !== null && price > opts.ceilingUsdPerNovel;
    // sufit sprawdzamy PRZED budżetem i bez dodawania do sumy: źródło ponad sufitem nie ma
    // prawa zajmować miejsca w kolejce, więc nie może też wypchnąć tańszego poza linię
    if (overCeiling) {
      out.push({
        id: r.id, verdict: "over-ceiling", rank: i + 1, usdPerFetch: r.usdPerFetch,
        ...(r.usdPerNovel === undefined ? {} : { usdPerNovel: r.usdPerNovel }),
        cumulativeUsd: round(cum),
      });
      return;
    }
    // Cena nieskończona (`novel === 0`) nie ma prawa zmieścić się w budżecie, choćby miejsce
    // zostało: „cokolwiek za zero nowych wydarzeń" jest złym interesem przy każdej kwocie,
    // a zachłanny spacer sam z siebie patrzy tylko na sumę, nie na cenę.
    const next = cum + r.usdPerFetch;
    const fits = Number.isFinite(price) && next <= valueBudget;
    if (fits) cum = next;
    out.push({
      id: r.id, verdict: fits ? "in-budget" : "over-budget", rank: i + 1,
      usdPerFetch: r.usdPerFetch,
      ...(r.usdPerNovel === undefined ? {} : { usdPerNovel: r.usdPerNovel }),
      cumulativeUsd: round(fits ? cum : next),
    });
  });

  let probCum = 0;
  for (const r of fresh) {
    const next = probCum + r.usdPerFetch;
    const fits = next <= probationBudget;
    if (fits) probCum = next;
    out.push({
      id: r.id, verdict: fits ? "probation" : "waiting", rank: null,
      usdPerFetch: r.usdPerFetch, cumulativeUsd: round(fits ? probCum : next),
    });
  }
  return out;
}

const round = (n: number): number => Number(n.toFixed(4));

/** Cena źródła brzegowego — próg, który WYSZEDŁ z budżetu zamiast być zgadnięty. */
export function marginalPrice(ranked: readonly Ranked[]): number | null {
  const inBudget = ranked.filter((r) => r.verdict === "in-budget");
  const last = inBudget[inBudget.length - 1];
  return last?.usdPerNovel ?? null;
}

/**
 * Dzienny budżet kanału FB: cały budżet miesięczny minus to, co realnie zjada RESZTA potoku.
 *
 * Świadomie liczone z pomiaru, nie z osobnego pokrętła „ile procent na FB". Dzięki temu
 * potanienie modelu samo oddaje miejsce kanałowi FB (ekstrakcja spadła z ~$0.75 do ~$0.04
 * dziennie po zmianie modelu 2026-08-16 i nikt nie musiał tego nigdzie przepisywać),
 * a podrożenie samo je zabiera. Ujemny wynik znaczy „reszta potoku już przekracza budżet" —
 * wtedy FB dostaje zero i regulator wycisza wszystko poza pasem pomiarowym.
 */
export function fbDailyBudget(monthlyUsd: number, nonFbDailyUsd: number): number {
  return Math.max(0, monthlyUsd / 30 - nonFbDailyUsd);
}
