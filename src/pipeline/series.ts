/**
 * Serie: rozwinięcie rytmu na wyjściu ze źródła i zwinięcie powtórzeń tuż przed publikacją.
 *
 * Dwie funkcje, jeden przepływ — i to jego kolejność jest tu całą treścią decyzji:
 *
 *   ekstrakcja → CACHE → expandRepeat → odsiew minionych → withoutCamps → dedupe
 *     → foldSeries → publikacja
 *
 * ROZWIJANIE STOI ZA CACHE'M, NIE PRZED. Wynik `expandRepeat` zależy od „dziś", a cache
 * ekstrakcji jest kluczowany hashem TREŚCI — zapisany w nim rekord rozwinięty to wartość
 * zależna od wejścia, którego nie ma w kluczu, więc odtworzenie z cache'a legalnie przestaje
 * zgadzać się samo ze sobą z dnia na dzień. Dokładnie ten sam argument stoi nad odsiewem
 * minionych w process-source.ts i jest tam starszy: rozwijanie było drugą funkcją, która
 * o nim zapomniała, bo siedziało wewnątrz `extractEvents`, czyli PRZED zapisem do cache'a.
 *
 * Rozwijamy na rekordy jednodniowe, więc wszystko pomiędzy (odsiew półkolonii, scalanie
 * duplikatów, geokodowanie, redakcja PII, raporty, refy) pracuje na jednym kształcie.
 * O kształcie w magazynie decyduje wyłącznie foldSeries() — jedna implementacja zwijania
 * dla WSZYSTKICH ścieżek naraz: modelu, plakatów, kalendarzy tribe/JSON-LD i wydarzeń FB.
 *
 * Że to musi stać w kodzie, a nie w prompcie, widać po danych: wszystkie cztery serie
 * w events.json z 2026-08-03 („ZAJĘCIA STAŁE W ODK BAJKA", „Kino letnie w Wirach",
 * „Zdrowy kręgosłup na trawie", „Wakacyjne wyjazdy") przyszły ścieżkami maszynowymi.
 * Żaden model ich nie widział — dokładnie ten sam argument, co w pipeline/camps.ts.
 *
 * foldSeries stoi PO dedupe, nie przed: dedupe scala to samo wydarzenie w tym samym dniu
 * z różnych źródeł, fold scala to samo wydarzenie w różnych dniach. Odwrotna kolejność
 * zwijałaby w serię duplikaty międzyźródłowe.
 *
 * Obie funkcje pilnują jednego niezmiennika kształtu w magazynie (types/event.ts): wydarzenie
 * jest ALBO jednodniowe, ALBO zakresem (`date_end`), ALBO serią (`dates`), i nigdy dwoma
 * naraz. `repeat` nie przechodzi przez `expandRepeat` — żyje wyłącznie na drucie.
 */
import { RUN_SCOPE, audit, auditFor } from "../shared/audit.js";
import { todayIso } from "../shared/dates.js";
import { MAX_OCCURRENCES, occurrences, parseRepeat } from "../shared/series.js";
import type { EventItem } from "../types/index.js";

// ============ rozwijanie: rytm z drutu → rekordy jednodniowe ============

/**
 * Jeden termin rytmu jako samodzielne wydarzenie jednodniowe.
 *
 * Zeruje WSZYSTKIE trzy pola kształtu, nie tylko datę: `date_end`, bo termin serii nie jest
 * zakresem; `dates`, bo rozwinięcie nie może odziedziczyć listy terminów po niczyim wcześniejszym
 * zwinięciu; `repeat`, bo za tą granicą rytm jest już rozliczony i nikt dalej nie ma prawa go
 * przeczytać po raz drugi. Ostatnie dwa to zabezpieczenie przed dokładnie tym stanem, który
 * zastaliśmy w state.json: rekordem, który miał naraz `repeat` i `dates`.
 */
const oneDay = (ev: EventItem, date: string): EventItem => {
  const { dates: _folded, ...rest } = ev;
  return { ...rest, date_start: date, date_end: null, repeat: "" };
};

/**
 * Rozwija `repeat` na osobne wydarzenia jednodniowe. Wołane na wyjściu ze źródła, na komplecie
 * (strona + followupy + cache), tuż przed odsiewem minionych — ścieżki maszynowe tego pola
 * nigdy nie ustawiają, więc ich nie dotyka.
 *
 * Każdy bezpiecznik kończy się TAK SAMO: rekord schodzi do JEDNEGO DNIA, a nie do zakresu.
 * To zmiana względem pierwszej wersji i kupiona konkretnym błędem w digeście: rekord
 * „Mała Zielarnia" z rytmem „pt,nd" i zakresem 03.07–12.08 nie miał już ani jednego terminu,
 * zostawał więc zakresem — a `occursIn` czyta zakres jako „trwa bez przerwy" i wypisał zajęcia
 * na środę 12.08, w której się nie odbywają. Rytm, którego nie umiemy rozwinąć, nie jest
 * sześciotygodniową imprezą; jedyne, co o nim wiemy na pewno, to jego pierwszy dzień.
 *
 * To nadal odmowa zgadywania, tylko konsekwentna: wpis bez rozwinięcia jest niepełny i wypada
 * jako miniony, wpis rozwinięty po omacku jest fałszywy i zostaje. Fałszu z danych już nikt
 * nie wyprostuje.
 */
export function expandRepeat(events: EventItem[], today = todayIso()): EventItem[] {
  const out: EventItem[] = [];
  for (const ev of events) {
    if (!ev.repeat) { out.push(ev); continue; }
    const dates = plannedDates(ev, today);
    if (dates.length > 1) {
      for (const date of dates) out.push(oneDay(ev, date));
      audit("series", `„${ev.title}" — rytm „${ev.repeat}" rozwinięty na ${dates.length} terminów `
        + `do ${dates[dates.length - 1]}`,
      { title: ev.title, repeat: ev.repeat, occurrences: dates.length });
      continue;
    }
    // powód, dla którego rytm się nie rozwinął, zapisało już plannedDates — tu zostaje sam skutek
    const date = dates[0] ?? ev.date_start;
    out.push(oneDay(ev, date));
    if (ev.date_end !== null && ev.date_end !== date) {
      audit("series", `„${ev.title}" — bez rozwinięcia rytmu zakres do ${ev.date_end} nie znaczy `
        + `„trwa bez przerwy", więc wpis zostaje jednodniowy (${date})`,
      { title: ev.title, repeat: ev.repeat, date, droppedRange: ev.date_end });
    }
  }
  return out;
}

/** Terminy, na które rozwija się rytm — pusto, gdy czegokolwiek brakuje albo nie da się odczytać. */
function plannedDates(ev: EventItem, today: string): string[] {
  const rule = parseRepeat(ev.repeat);
  if (!rule) {
    audit("series", `„${ev.title}" — rytmu „${ev.repeat}" nie da się odczytać, wpis zostaje jednorazowy`,
      { title: ev.title, repeat: ev.repeat });
    return [];
  }
  // Bez końca zakresu rytm nie ma granicy, a doklejenie jakiejkolwiek byłoby wymyśleniem
  // terminów. Prompt mówi wprost, że date_end jest wtedy obowiązkowe — to ślad z tego, że nie było.
  if (ev.date_end === null || ev.date_end <= ev.date_start) {
    audit("series", `„${ev.title}" — rytm „${ev.repeat}" bez date_end, nie ma czego rozwijać`,
      { title: ev.title, repeat: ev.repeat, date_start: ev.date_start, date_end: ev.date_end });
    return [];
  }
  // start przycięty do dziś: kontrakt „daty przeszłe pomijaj" dotyczy też terminów serii,
  // a plakat na cały sezon trafia do nas w jego połowie
  const from = ev.date_start > today ? ev.date_start : today;
  const dates = occurrences(rule, from, ev.date_end);
  // jedyna gałąź, która dotąd nie zostawiała ŻADNEGO śladu — a to ona stała za wpisem
  // wypisanym na dzień, w którym się nie odbywa (patrz nagłówek expandRepeat)
  if (!dates.length) {
    audit("series", `„${ev.title}" — rytm „${ev.repeat}" nie ma już ani jednego terminu `
      + `między ${from} a ${ev.date_end}`,
    { title: ev.title, repeat: ev.repeat, from, date_end: ev.date_end });
  }
  if (dates.length === MAX_OCCURRENCES) {
    audit("series", `„${ev.title}" — rytm dał więcej niż ${MAX_OCCURRENCES} terminów, `
      + `bierzemy pierwsze do ${dates[dates.length - 1]}`,
    { title: ev.title, repeat: ev.repeat, cap: MAX_OCCURRENCES });
  }
  return dates;
}

// ============ zwijanie: powtórzenia → jeden rekord z listą terminów ============

/** Rekord wchłonięty przez serię i wpis, który go zastąpił — kształt zgodny z DedupeDrop. */
export interface SeriesFold {
  loser: EventItem;
  winner: EventItem;
}

export interface FoldResult {
  events: EventItem[];
  dropped: SeriesFold[];
}

/**
 * Pola, które w obrębie serii mają prawo się różnić.
 *
 * `source_url` jest tu z konieczności udokumentowanej danymi: kalendarz `tribe` daje każdemu
 * terminowi własny adres (`…/zajecia-stale-w-odk-bajka-2/`, `-3/`, `-4/`), więc bez tego
 * wyłączenia nie zwinęłaby się ani jedna seria. Rekord serii niesie adres pierwszego terminu;
 * podstrony kolejnych opisują to samo wydarzenie.
 */
const VOLATILE = new Set(["date_start", "date_end", "dates", "source_url", "repeat"]);

/**
 * Tożsamość serii: CAŁY rekord poza polami zmiennymi.
 *
 * Reguła jest bezstratna z definicji — jeśli dwa rekordy różnią się wyłącznie terminem,
 * nie niosą żadnej informacji per-termin, więc scalenie niczego nie gubi. Dlatego nie ma
 * tu normalizacji tytułu ani progu podobieństwa: „Kino letnie w Wirach - seans: Nomadland"
 * i „…- seans: Krudowie 2" mają w tytule prawdziwą różnicę i zostają osobno.
 *
 * `source_id` jest częścią tożsamości, więc serie nie sklejają się między źródłami —
 * od scalania międzyźródłowego jest dedupe, który przebiegł wcześniej.
 */
function identity(ev: EventItem): string {
  const stable = Object.entries(ev)
    .filter(([key]) => !VOLATILE.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(stable);
}

/**
 * Zwija powtórzenia w jeden wpis z listą `dates`.
 *
 * Ocalały rekord jest MUTOWANY w miejscu, a nie tworzony na nowo: `producedBy` w daily.ts
 * i redakcja PII rozpoznają wydarzenia po tożsamości obiektu w pamięci, więc podmiana
 * rekordu na kopię cicho rozspójniłaby raport przebiegu.
 *
 * Do serii wchodzą WYŁĄCZNIE rekordy jednodniowe, i każdy z dwóch warunków wyklucza inny
 * kształt (types/event.ts):
 *
 *  - `date_end !== null` to ZAKRES: „trwa bez przerwy" (festiwal 01–03.08), nie „powtarza się".
 *    Zmieszanie tych znaczeń zamieniłoby trzydniową imprezę w trzy osobne terminy.
 *  - `dates` to SERIA JUŻ ZWINIĘTA. Dotąd wypadała przez pierwszy warunek, bo zwijanie
 *    ustawiało jej `date_end` — czyli pole danych pełniło funkcję znacznika „przetworzone".
 *    Warunek na `dates` mówi to samo wprost, a `date_end` zostaje przy jednym znaczeniu.
 *
 * Zwycięzca NIE dostaje `date_end`: ostatni termin serii stoi w `dates` i powtarzanie go
 * w polu, które wszędzie indziej znaczy „bez przerwy", było źródłem tej dwuznaczności.
 * Kto potrzebuje ostatniego dnia, woła `lastDay()`.
 */
export function foldSeries(events: EventItem[]): FoldResult {
  const groups = new Map<string, EventItem[]>();
  for (const ev of events) {
    if (ev.date_end !== null || ev.dates) continue;
    const key = identity(ev);
    const group = groups.get(key);
    if (group) group.push(ev);
    else groups.set(key, [ev]);
  }

  const absorbed = new Map<EventItem, EventItem>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date_start.localeCompare(b.date_start));
    const winner = sorted[0]!;
    const dates = [...new Set(sorted.map((ev) => ev.date_start))];
    winner.dates = dates;
    for (const loser of sorted.slice(1)) absorbed.set(loser, winner);
    auditFor(winner.source_id ?? RUN_SCOPE, "series",
      `„${winner.title}" — ${group.length} rekordów różniących się wyłącznie datą zwinięte `
      + `w jedną serię (${dates.length} terminów do ${dates[dates.length - 1]})`,
      { title: winner.title, folded: group.length, occurrences: dates.length });
  }

  const dropped = [...absorbed].map(([loser, winner]) => ({ loser, winner }));
  return { events: events.filter((ev) => !absorbed.has(ev)), dropped };
}
