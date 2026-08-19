/**
 * KOLEJKA FOLLOWUPÓW: który ze wskazanych adresów pobieramy, kiedy nie mieszczą się wszystkie.
 *
 * Do 2026-08-19 kolejność była PRZYPADKIEM — tą, w której model wypisał odnośniki — a limit
 * ucinał ogon. Zmierzone na `mosina-pl-wydarzenia` (przebieg 2026-08-19): model wskazał pięć
 * podstron, wejście z etapu 1 doklejone na początek wypchnęło piątą, a była nią
 * `…/pippi-langstrumpf-zwiedza-swiat` — jedyny wpis tego źródła BEZ miejsca i BEZ godziny.
 * Pobrane zamiast niej dwa „Zebranie Wiejskie Sołectwa…" miały świetlicę i termin już na karcie
 * listingu, a przyniosły 12 linii `dedupe.dropped`, wszystkie ze sobą samymi. Trzy sloty z pięciu
 * poszły na powtórzenie tego, co potok już wiedział.
 *
 * Stąd dwie reguły. Obie są DARMOWE — nie podnoszą liczby pobrań, tylko ustawiają, co się w niej
 * mieści; limit jest osobnym pokrętłem (`FOLLOWUPS_PER_SOURCE`).
 *
 *   1. DEFICYT PRZED KOMPLETEM. Adres, pod którym stoi wpis bez `venue` albo bez `time_start`,
 *      idzie przed adresem wpisu kompletnego. Followup istnieje po to, żeby dociągnąć to, czego
 *      na karcie listingu nie ma — a nic w potoku dotąd nie pytało, czy czegoś brakuje.
 *
 *      Sygnał jest STABILNY między przebiegami i to jest warunek, żeby wolno go było użyć do
 *      sortowania: liczymy go z wydarzeń STRONY ŹRÓDŁA (karty listingu), nie z sumy po
 *      followupach. Karta Pippi nie dostanie miejsca ani jutro, ani za tydzień — pełny rekord
 *      przychodzi osobno, z podstrony, i dopiero dedupe scala oba po tytule i dacie. Gdyby
 *      deficyt liczyć z sumy, wpis uzupełniony wczoraj spadałby dziś na koniec kolejki, jutro
 *      wracał na początek i wydarzenia migotałyby z przebiegu na przebieg.
 *
 *   2. ADRES ZNANY JAKO TA SAMA STRONA nie zajmuje miejsca w kolejce. `same-as-page` potok
 *      wykrywał już wcześniej (patrz followup.ts, warstwa 3), ale DOPIERO PO tym, jak slot
 *      został zużyty — a `mosina.pl/wydarzenia?page=1` oddaje bajt w bajt to samo, co
 *      `/wydarzenia`, w KAŻDYM przebiegu od 2026-08-13 (2 takie followupy dziennie, stale).
 *      Jedno pobranie po nic jest tanie; zjedzony slot kosztował całe wydarzenie.
 *
 *      Wpis NIE jest wieczny: po `FOLLOWUP_SAME_PAGE_RECHECK_DAYS` adres wraca do kolejki, bo
 *      serwis może kiedyś rozdzielić paginację i nikt nam tego nie zgłosi. Ta sama zasada, co
 *      przy grupach FB i wyciszeniu kosztowym — stan „raz zapadł, na zawsze" jest błędem.
 *
 * CZEGO TA KOLEJKA NIE ROBI: nie rotuje. Adresy ponad limit czekają na podniesienie limitu,
 * a nie na następny przebieg — bo events.json powstaje od nowa w każdym przebiegu i followup
 * pominięty dziś zabiera ze sobą swoje wydarzenia, choćby siedziały w cache'u. Rotacja (jak
 * w sondzie kontenerów, gdzie parasol i tak wraca) znaczyłaby tu migotanie wpisów w rejestrze.
 */
import { P } from "../../config/index.js";
import { audit } from "../../shared/audit.js";
import { addDays } from "../../shared/dates.js";
import { urlKey } from "../../shared/url.js";
import type { EventItem, PipelineState, Source } from "../../types/index.js";

import { entryUrl } from "./entry-url.js";

/** Sufit followupów na źródło — ta sama liczba jedzie do promptu, patrz `pipeline/prompts.ts`. */
export const followupsPerSource = (): number => Math.max(P.FOLLOWUPS_PER_SOURCE.get(), 0);

/**
 * Adresy wpisów, którym brakuje miejsca albo godziny — jedyny powód, dla którego warto coś
 * dociągać. Pusty `venue` i `null` w `time_start` to ten sam brak: schemat rozróżnia je
 * wyłącznie typem pola.
 */
function deficitUrls(events: readonly EventItem[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.venue && ev.time_start) continue;
    if (ev.source_url) out.add(urlKey(ev.source_url));
  }
  return out;
}

/** Czy ten adres jest ZNANY jako bajt w bajt ta sama treść, co strona źródła. */
export function knownSameAsPage(
  url: string, srcId: string, state: PipelineState, today: string,
): boolean {
  const days = P.FOLLOWUP_SAME_PAGE_RECHECK_DAYS.get();
  if (days <= 0) return false; // 0 = mechanizm wyłączony, każdy adres wraca do kolejki
  const at = state.sameAsPage?.[srcId]?.[urlKey(url)];
  if (at === undefined) return false;
  return addDays(at, days) > today;
}

/**
 * Zapamiętanie werdyktu „to ta sama strona". Wołane z `processFollowup` — czyli w miejscu,
 * w którym porównanie hashy właśnie zapadło, a nie w domysłach kolejki.
 */
export function rememberSameAsPage(
  url: string, srcId: string, state: PipelineState, today: string,
): void {
  const perSource = ((state.sameAsPage ??= {})[srcId] ??= {});
  perSource[urlKey(url)] = today;
}

export interface QueueCtx {
  srcId: string;
  state: PipelineState;
  /** wydarzenia STRONY ŹRÓDŁA — wyłącznie z nich liczymy deficyt, patrz nagłówek */
  events: readonly EventItem[];
  /** YYYY-MM-DD */
  today: string;
}

/**
 * Kolejka gotowa do pobrania: bez adresów znanych jako ta sama strona, deficytem do przodu,
 * przycięta do limitu. Ślad zostawiamy tylko wtedy, gdy któraś z reguł COŚ zmieniła — inaczej
 * czterdzieści źródeł dopisywałoby dziennie czterdzieści notek „nie zrobiłem nic".
 */
export function queueFollowups(urls: readonly string[], ctx: QueueCtx): string[] {
  const kept: string[] = [];
  for (const url of urls) {
    if (!knownSameAsPage(url, ctx.srcId, ctx.state, ctx.today)) { kept.push(url); continue; }
    audit("followup.proposed",
      "ten adres oddawał już bajt w bajt treść strony źródła — nie zajmuje miejsca w kolejce",
      { url });
  }

  const wanted = deficitUrls(ctx.events);
  // sort STABILNY (Node ≥ 11): kolejność modelu zostaje wewnątrz obu grup, zmienia się tylko to,
  // która grupa stoi przed którą. Propozycja modelu nadal niesie sygnał — po prostu nie jest
  // jedynym, jaki mamy.
  const ranked = [...kept].sort(
    (a, b) => Number(wanted.has(urlKey(b))) - Number(wanted.has(urlKey(a))),
  );

  const limit = followupsPerSource();
  const taken = ranked.slice(0, limit);
  const moved = taken.filter((url, i) => kept[i] !== url).length;
  if (moved > 0) {
    audit("followup.proposed",
      `podstrony wpisów bez miejsca albo bez godziny idą przed komplet — kolejka przestawiona `
      + `na ${moved} pozycjach`,
      { moved, deficit: wanted.size, taken: taken.length });
  }
  if (ranked.length > limit) {
    audit("followup.proposed",
      `${ranked.length} adresów po odsiewie, a limit na źródło to ${limit} — `
      + `${ranked.length - limit} nie pobieramy w ogóle`,
      { queued: ranked.length, taken: limit, over: ranked.length - limit });
  }
  return taken;
}

/**
 * Wejście z etapu 1 doklejone do kolejki.
 *
 * Etap 1 ustala, GDZIE serwis wypisuje wydarzenia, i do 2026-08 nikt tego nie czytał:
 * 26 z 41 pobieranych źródeł wchodziło korzeniem serwisu, a nie listą imprez. Wejście DOKŁADA
 * się do korzenia, a nie go zastępuje — pomiar (2026-08-01, sam fetch, bez modelu) pokazał,
 * że wymiana bywa STRATĄ: lubon.pl ma na stronie głównej 6 różnych dat, a na
 * `/artykuly/350/wydarzenia` zero; kultura.poznan.pl odpowiednio 5 i zero. Odwrotnie niż
 * w komorniki.pl (1 na korzeniu, 11 pod kalendarzem). Skoro raz jedno, raz drugie, to wybór
 * między nimi byłby zgadywaniem, a suma jest zawsze ≥ każdej ze stron z osobna.
 *
 * NA POCZĄTEK listy, bo o adresie z etapu 1 WIEMY, że stoją pod nim wydarzenia, a propozycja
 * modelu jest tylko propozycją. Ale doklejenie nie jest darmowe: lista jest już przycięta do
 * limitu, więc każde wejście wypycha z niej ostatni followup. Dlatego wejście znane jako bajt
 * w bajt ta sama strona nie dokłada się wcale — `mosina.pl/wydarzenia?page=1` robił to
 * w każdym przebiegu od 2026-08-13, za cenę jednej niedoczytanej podstrony dziennie.
 */
export function attachEntrypoint(
  urls: string[], ctx: { src: Source; state: PipelineState; pageUrl: string; today: string },
): string[] {
  const { src, state, pageUrl, today } = ctx;
  const entry = entryUrl(src);
  for (const s of entry.skipped ?? []) {
    audit("url.skipped",
      `etap 1 wskazał „/${s.segment}/" jako listę wydarzeń — to repertuar, `
      + "więc wchodzimy korzeniem serwisu",
      { url: s.url, segment: s.segment });
  }
  const key = urlKey(entry.url);
  if (key === urlKey(pageUrl) || urls.some((u) => urlKey(u) === key)) return urls;
  if (knownSameAsPage(entry.url, src.id, state, today)) {
    audit("followup.proposed",
      "wejście z etapu 1 oddawało już bajt w bajt treść strony źródła — nie dokładamy go",
      { url: entry.url });
    return urls;
  }
  if (!entry.entrypoint) return urls;
  audit("followup.proposed",
    `wejście z etapu 1 (${entry.entrypoint.kind}, ×${entry.entrypoint.detailCount ?? "?"} odnośników) `
    + "dołącza do followupów",
    { url: entry.url, via: entry.entrypoint.via, confidence: entry.entrypoint.confidence });
  return [entry.url, ...urls].slice(0, followupsPerSource());
}
