/**
 * OBCE HOSTY FOLLOWUPÓW: adres, pod który wychodzimy z cudzej strony, i który nic nie daje.
 *
 * Zjawisko z przebiegu 2026-08-21 (`dopiewo-tablica-ogloszen-fb`): udostępniony post odesłał
 * potok na `st.pl/trip/index` — katalog biura podróży. Followup kosztował $0.0104, czyli
 * WIĘCEJ niż cała strona źródła ($0.0102), i oddał 38 „wydarzeń", z których do publikacji nie
 * weszło ani jedno (wycieczki zagraniczne, patrz `pipeline/locality.ts`, plus duplikaty).
 *
 * Dlaczego nie lista domen: za rok będzie 99 innych biur podróży pod 99 innymi adresami,
 * a wpisanie `st.pl` do jakiegokolwiek `if` załatwia jeden wiersz danych zamiast zjawiska.
 * Ten licznik nie zna ani jednej nazwy — uczy się ich sam i sam o nich zapomina.
 *
 * PLON LICZYMY PO PUBLIKACJI, nie po ekstrakcji, i to jest sedno. `st.pl` oddał 38 rekordów:
 * po liczbie wyciągniętych wydarzeń był NAJLEPSZYM followupem tamtego przebiegu. Dopiero
 * pytanie „ile z nich czytelnik zobaczył" (po odsiewie i po scalaniu duplikatów) odróżnia
 * katalog wycieczek od podstrony domu kultury.
 *
 * Trzy bezpieczniki, bo pomyłka wycisza CAŁY serwis, a nie jeden wiersz w raporcie:
 *   - liczymy WYŁĄCZNIE hosty OBCE wobec źródła. Podstrony własnego serwisu gminy nie mają
 *     jak tu trafić, choćby milczały tygodniami;
 *   - host obecny w rejestrze źródeł jest nietykalny. `bibldop-wydarzenia` linkuje do
 *     `dopiewo.pl`, który sami skrobiemy — wyciszenie zabrałoby nam wejście do własnego źródła;
 *   - liczymy tylko followupy `kind: "page"`. Plakat to inna ekonomia (jedno wywołanie
 *     wizyjne) i inny adres wyniku: wydarzenie z plakatu wskazuje POST, nie plik graficzny,
 *     więc host obrazu wyglądałby na jałowy zawsze i wyciszyłby sam odczyt plakatów.
 *
 * Wyciszenie WYGASA (`FOLLOWUP_HOST_RECHECK_DAYS`), bo serwis może zacząć publikować coś
 * naszego, a nikt nam tego nie zgłosi — stan „raz zapadł, na zawsze" jest błędem projektowym.
 * Jeden opublikowany wpis zeruje serię, dokładnie jak przy grupach FB.
 *
 * Progi (wartości domyślne i pełny opis: src/config/params.ts):
 *   FOLLOWUP_HOST_LIMIT, FOLLOWUP_HOST_RECHECK_DAYS
 */
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { addDays } from "../../shared/dates.js";
import { eventKey } from "../../shared/event-key.js";
import { host } from "../../shared/url.js";
import type { EventItem, FollowupRun, PipelineState, SourceRun } from "../../types/index.js";

/**
 * Co dał followup danego hosta W TYM PRZEBIEGU — KLUCZAMI wydarzeń, nie adresami.
 *
 * Pierwsza wersja pytała, czy któreś opublikowane wydarzenie ma `source_url` na tym hoście,
 * i była BŁĘDNA. Zmierzone na przebiegu 2026-08-21: followup na `imd.org.pl` oddał sześć
 * wpisów o bawialni, a opublikowane rekordy wskazują POST z grupy FB — bo tam model kazał
 * czytelnikowi pójść. Host wyglądałby na jałowy i po trzech przebiegach wyleciałby z kolejki,
 * zabierając ze sobą jedyne miejsce, z którego znamy godziny bawialni.
 *
 * Klucz (`shared/event-key.ts`) przeżywa i klonowanie z cache'u, i scalanie duplikatów —
 * zwycięzca dedupe ma z definicji ten sam klucz, co przegrany. Pamięć jest NA PRZEBIEG:
 * pytanie brzmi „co ten host dał dzisiaj", a nie „co kiedykolwiek".
 */
const producedKeys = new Map<string, Set<string>>();

/** Start przebiegu: pamięć plonu jest per przebieg, więc musi zaczynać pusta. */
export function resetFollowupHosts(): void { producedKeys.clear(); }

/**
 * Wydarzenia oddane przez jeden followup. Wołane z `pullOne` — także dla wyniku ODTWORZONEGO
 * z cache'u, bo „strona się nie zmieniła" nie znaczy „nic nie wniosła".
 */
export function noteFollowupEvents(
  url: string, kind: FollowupRun["kind"], events: readonly EventItem[],
): void {
  if (kind !== "page") return; // plakaty liczą się osobno, patrz nagłówek
  const h = host(url);
  if (!h) return;
  const keys = producedKeys.get(h) ?? new Set<string>();
  for (const ev of events) keys.add(eventKey(ev.title, ev.date_start));
  producedKeys.set(h, keys);
}

export const hostLimit = (): number => P.FOLLOWUP_HOST_LIMIT.get();
export const hostRecheckDays = (): number => P.FOLLOWUP_HOST_RECHECK_DAYS.get();

export type HostEntry = NonNullable<PipelineState["followupHosts"]>[string];

/**
 * Czy ten adres jest dziś wyciszony. `null` = pobieramy normalnie, w tym w dniu sondy —
 * sonda to zwykłe pobranie, którego wynik przejdzie przez `noteFollowupHosts` jak każdy inny.
 */
export function followupHostMuted(
  url: string, state: PipelineState, today: string,
): HostEntry | null {
  const limit = hostLimit();
  if (!limit) return null; // 0 = mechanizm wyłączony
  const entry = state.followupHosts?.[host(url)];
  if (!entry || entry.runs < limit) return null;
  if (today >= addDays(entry.lastTry, hostRecheckDays())) return null;
  return entry;
}

/** Hosty, pod które ten przebieg realnie wyszedł poza serwis źródła. */
function foreignHosts(runs: readonly SourceRun[], registry: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    const own = host(run.url);
    for (const fu of run.followups) {
      if (fu.kind !== "page") continue;
      const h = host(fu.url);
      if (h && h !== own && !registry.has(h)) out.add(h);
    }
  }
  return out;
}

/** Werdykt serii słowami: czy to już wyciszenie, czy jeszcze pobieramy. */
function note(h: string, entry: HostEntry): string {
  const limit = hostLimit();
  if (entry.runs >= limit) {
    return `„${h}": ${entry.runs}. przebieg z rzędu bez ani jednego opublikowanego wydarzenia `
      + `— od następnego nie zajmuje miejsca w kolejce, sonda co ${hostRecheckDays()} dni`;
  }
  return `„${h}": przebieg bez opublikowanego wydarzenia — ${entry.runs}/${limit} z rzędu, `
    + "jeszcze pobieramy (jeden pusty dzień to nie werdykt)";
}

/**
 * Wpis o przerwanej serii nie ma czego pilnować, a `state.json` jest COMMITOWANY — host
 * odwiedzony raz i nigdy więcej zostawałby w nim na zawsze. Wyciszonych nie ruszamy:
 * to ICH wpis trzyma wyciszenie przy życiu.
 */
function prune(reg: Record<string, HostEntry>, today: string): void {
  const limit = hostLimit();
  for (const [h, entry] of Object.entries(reg)) {
    if (entry.runs >= limit) continue;
    if (today >= addDays(entry.lastTry, hostRecheckDays())) delete reg[h];
  }
}

/**
 * Rozliczenie przebiegu: co obce hosty dały PO publikacji.
 *
 * Wołane raz, po dedupe i zwijaniu serii — wcześniej nie wiadomo, które rekordy przeżyły,
 * a to jest jedyna liczba, o którą tu chodzi.
 */
export function noteFollowupHosts(opts: {
  runs: readonly SourceRun[];
  /** wydarzenia PO odsiewie, dedupe i seriach — czyli te, które zobaczy czytelnik */
  published: readonly EventItem[];
  /** hosty źródeł z rejestru: nietykalne, patrz nagłówek */
  registry: ReadonlySet<string>;
  state: PipelineState;
  today: string;
}): void {
  const limit = hostLimit();
  if (!limit) return;
  const tried = foreignHosts(opts.runs, opts.registry);
  if (!tried.size) return;

  const publishedKeys = new Set(opts.published.map((ev) => eventKey(ev.title, ev.date_start)));
  const yielded = (h: string): boolean => {
    const keys = producedKeys.get(h);
    return keys ? [...keys].some((k) => publishedKeys.has(k)) : false;
  };

  const reg = (opts.state.followupHosts ??= {});
  let muted = 0;
  for (const h of tried) {
    const prev = reg[h];
    if (yielded(h)) {
      if (prev) {
        audit("followup.host",
          `„${h}" znowu coś opublikował po ${prev.runs} jałowych przebiegach — licznik wyzerowany`,
          { host: h, was: prev.runs, since: prev.since });
        delete reg[h];
      }
      continue;
    }
    const entry: HostEntry = {
      runs: (prev?.runs ?? 0) + 1, since: prev?.since ?? opts.today, lastTry: opts.today,
    };
    reg[h] = entry;
    if (entry.runs >= limit) muted += 1;
    audit("followup.host", note(h, entry),
      { host: h, runs: entry.runs, limit, since: entry.since });
  }
  prune(reg, opts.today);
  audit("followup.host",
    `obce serwisy w followupach: ${tried.size} odwiedzonych, `
    + `${[...tried].filter(yielded).length} coś opublikowało`
    + (muted ? `, ${muted} osiągnęło próg wyciszenia` : ""),
    { hosts: tried.size, muted, tracked: Object.keys(reg).length });
}
