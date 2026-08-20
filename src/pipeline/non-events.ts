/**
 * Wpisy, które wyglądają jak wydarzenie, a nie są — odsiew wspólny dla wszystkich ścieżek.
 *
 * Serwis obiecuje jedno: rzeczy, na które da się po prostu PRZYJŚĆ. Turnus półkolonii
 * z zapisami w maju i spotkanie organizacyjne przed wyjazdem tej obietnicy nie spełniają,
 * a miejsce w digeście zajmują takie samo jak koncert.
 *
 * Dlaczego reguła stoi w KODZIE, skoro model ma już pole `is_noise`: te dwa mechanizmy
 * mają różny ZASIĘG i celowo się nie dublują.
 *   - `is_noise` (opis pola w `types/event-schema.ts`) to werdykt MODELU. Łapie warianty,
 *     których nie przewidziałem, ale działa wyłącznie na ścieżce modelu, wyłącznie przy
 *     świeżej ekstrakcji, i odsiewa dopiero przy publikacji (digest, `template.html`) —
 *     rekord zostaje w `events.json` i panel liczy go jako szum.
 *   - Ten plik to werdykt KODU. „II Turnus Letnich Półkolonii" (dk-pod-lipami, events.json
 *     z 2026-08-03) przyszedł ścieżką maszynową z kalendarza `tribe`, czyli z
 *     `extract/from-capability.ts` — żaden model go nie widział i żadne zdanie w prompcie
 *     by go nie zatrzymało. Do tego wydarzenia raz wyciągnięte siedzą w cache ekstrakcji
 *     (`state.extractions`) i wracają z niego bez pytania modelu, dopóki treść strony się
 *     nie zmieni. Odsiew przed scalaniem jest jedynym punktem, przez który przechodzą
 *     WSZYSTKIE ścieżki naraz: model, followupy, plakaty, cache, wyjścia maszynowe i FB.
 *
 * Stąd podział pracy: do rejestru niżej trafia zjawisko o STAŁEJ nazwie, którą widać
 * w danych i którą da się złapać rdzeniem słowa. Rozmyte przypadki („to raczej ogłoszenie
 * niż impreza") zostają przy modelu — od zgadywania jest on, nie regex.
 */
import { RUN_SCOPE, auditFor } from "../shared/audit.js";
import type { EventItem } from "../types/index.js";

/** Jedno zjawisko: po czym je poznać i co powiedzieć w śladzie temu, kto pyta „czemu tego nie ma". */
interface NonEvent {
  /** Nazwa zjawiska — idzie do `detail.why`, więc ma się nadawać do grupowania w panelu. */
  why: string;
  /** Czym ten wpis JEST, skoro nie jest wydarzeniem — druga połowa zdania w nocie śladu. */
  is: string;
  re: RegExp;
}

/**
 * Zakres każdego wzorca jest wąski celowo — pomyłka w tę stronę jest niewidoczna
 * (skasowanego wydarzenia nikt nie zobaczy w digeście), więc rozstrzygamy na korzyść
 * wpisu, a nie odsiewu. Dlatego:
 *   - „kolonie", „obóz" i „zimowisko" tu NIE są: „obóz" bywa tytułem wystawy, a „Kolonia"
 *     nazwą miejscowości;
 *   - łapiemy „spotkanie organizacyjne", ale nie „spotkanie informacyjne" — na to drugie
 *     da się przyjść i bywa jedynym punktem programu (np. spotkanie o dopłatach);
 *   - komisje rady, zebrania wiejskie i przetargi zostają przy `is_noise`: model radzi
 *     sobie z nimi od dawna (9 z 234 wpisów w events.json z 2026-08-18), a jako szum
 *     zliczony w panelu są bardziej użyteczne niż jako rekord skasowany bez śladu liczby.
 */
const RULES: NonEvent[] = [
  {
    why: "półkolonie",
    is: "turnus z zapisami, nie wydarzenie do przyjścia",
    // jeden rdzeń załatwia odmianę („Półkolonii", „półkoloni"), a klasy znaków obie
    // pisownie — źródła gubią ogonki, zwłaszcza w tagach i slugach
    re: /p[oó][łl]koloni/i,
  },
  {
    why: "spotkanie organizacyjne",
    is: "ustalenia PRZED wydarzeniem, nie samo wydarzenie",
    // „Spotkanie organizacyjne dotyczące wyjazdu do Rewala" (mieszkancy-lubonia-fb-group,
    // events.json z 2026-08-18) — model przepuścił, bo opis `is_noise` wymieniał wtedy
    // wyłącznie sprawy urzędowe. Oba szyki, bo „organizacyjne spotkanie" też się zdarza.
    re: /(spotkani|zebrani|zbi[oó]rk)\w*\s+organizacyjn|organizacyjn\w*\s+(spotkani|zebrani|zbi[oó]rk)/i,
  },
  {
    why: "zwolniony termin w usłudze",
    is: "wizyta do umówienia u kogoś, nie wydarzenie do przyjścia",
    // „Zwolnił się termin na stylizację dłoni lub stóp" — dwa wpisy w events.json
    // z 2026-08-20 (mieszkancy-lubonia-fb-group), oba z PLAKATU i oba z `venue: ""`,
    // bo salon podaje adres tylko w komentarzu. Model dał im nawet godzinę, więc
    // w digeście wyglądałyby jak zwykłe wydarzenie.
    //
    // Idiom ogłoszeń usługowych (paznokcie, fryzjer, dentysta) i dlatego nadaje się
    // do rejestru: ma STAŁĄ nazwę. Wzorzec celowo wymaga „zwolnił się" — samo
    // „wolny termin" łapałoby warsztaty z zapisami, na które przyjść MOŻNA.
    // Do dwóch słów przerwy, żeby zmieścić „zwolniły się DWA ostatnie terminy".
    // `[łl]` jawnie, bo `\w` w JS jest ASCII-only i zatrzymuje się na „ł" —
    // dokładnie ten sam powód, dla którego „półkoloni" wyżej ma klasy znaków, a nie `\w`
    re: /zwolni[łl]\w*\s+si[eę](?:\s+\S+){0,2}\s+(?:termin|miejsc)/i,
  },
];

/** Tytuł, kontener i tagi — trzy miejsca, w których nazwa zjawiska naprawdę występuje. */
export const nonEventRule = (ev: EventItem): NonEvent | undefined =>
  RULES.find((r) => r.re.test(ev.title) || r.re.test(ev.container) || ev.tags.some((t) => r.re.test(t)));

export const isNonEvent = (ev: EventItem): boolean => nonEventRule(ev) !== undefined;

/**
 * Odsiew tuż przed scalaniem duplikatów.
 *
 * Ślad idzie do ŹRÓDŁA, które wydarzenie dało — tam go szuka ktoś, kto pyta „czemu tego
 * nie ma", dokładnie tak samo jak przy przegranych dedupe. Rekord zostaje przy tym
 * w `SourceRun.produced` i w `run.events`: to jest stan sprzed scalania, a odjęcie od
 * niego odsiewu zafałszowałoby odpowiedź na pytanie, co źródło faktycznie wyprodukowało.
 *
 * Podsumowanie rozbija odsiew NA ZJAWISKA, bo suma „7 wpisów" nie odpowiada na jedyne
 * pytanie, które to podsumowanie ma sens zadawać: czy któryś wzorzec nie zaczął właśnie
 * kosić za szeroko.
 */
export function withoutNonEvents(events: EventItem[]): EventItem[] {
  const byWhy = new Map<string, number>();
  const kept = events.filter((ev) => {
    const rule = nonEventRule(ev);
    if (!rule) return true;
    byWhy.set(rule.why, (byWhy.get(rule.why) ?? 0) + 1);
    auditFor(ev.source_id ?? RUN_SCOPE, "event.dropped",
      `„${ev.title}" — ${rule.why}: ${rule.is}`,
      { title: ev.title, date: ev.date_start, why: rule.why });
    return false;
  });
  const dropped = events.length - kept.length;
  if (dropped) {
    const split = [...byWhy].map(([why, n]) => `${why} ${n}`).join(", ");
    auditFor(RUN_SCOPE, "event.dropped",
      `odsiew nie-wydarzeń: ${dropped} wpisów nie idzie do publikacji (${split})`,
      { dropped, kept: kept.length, ...Object.fromEntries(byWhy) });
  }
  return kept;
}
