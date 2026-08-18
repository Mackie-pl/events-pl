/**
 * KONTENERY: wpis, który wygląda na wydarzenie, a jest STRONĄ PROGRAMU.
 *
 * Zjawisko zobaczone na `okpoznan-wydarzenia` (2026-08-18). Karta listingu:
 *
 *     Lip 27 – Sie 31 · 60+ · Seniorzy w akcji | Twój wiek jest Twoim atutem
 *     [/szczegoly-wydarzenia/c0ucEPTTWzwrMWBCZpHQ_seniorzy-w-akcji-…]
 *
 * Pod tym odnośnikiem stoi dziesięć zajęć z godzinami i miejscami — nordic walking
 * w poniedziałki 12:00 nad Maltą, badminton we wtorki w Hali Wilda, tai chi w środy
 * na Pływalni Grunwald, a od września sześć zajęć „Przyjdź z wnukami". Do rejestru weszła
 * z tego JEDNA linia: bez godziny, bez miejsca, rozciągnięta na 36 dni.
 *
 * DLACZEGO PROMPT TEGO NIE ZAŁATWIA. Reguła „program pod linkiem → followup" istnieje
 * (prompts.ts, EXTRACTION_RULES) i model jej nie złamał: z karty listingu NIE DA SIĘ poznać,
 * że pod odnośnikiem stoi program. Karta niesie tytuł, zakres dat i wiek — dokładnie tyle
 * samo, co karta zwykłego wydarzenia. Model przeczytał ją bezbłędnie; sygnału po prostu
 * w niej nie było. Jest za to w KSZTAŁCIE wpisu, który z niej wyszedł — czyli u nas,
 * po ekstrakcji, za darmo.
 *
 * FINGERPRINT: zakres wielu dni + brak rytmu + brak godziny startu.
 * Każdy człon odpowiada za coś innego i dopiero razem znaczą „to nie jest jeden termin":
 *   - zakres bez rytmu — potok nie ma z tego ani jednego konkretnego terminu; `occursIn`
 *     czyta taki wpis jako „trwa bez przerwy", więc wchodzi do KAŻDEGO okna digestu
 *     między 27.07 a 31.08. Funkcjonalnie jest to atrakcja stała, czyli dokładnie to,
 *     co reguła „BEZ DATY = NIE WYDARZENIE" miała odciąć. Reguła patrzy jednak wyłącznie
 *     na obecność `date_start` — i dlatego 36-dniowy parasol przez nią przechodzi.
 *   - brak godziny — najmocniejszy dowód, że nikt nie opisywał pojedynczego wystąpienia.
 *     Kosztuje nas 1 wpis z 18 (patrz pomiar niżej), bo „OFERTA INDYWIDUALNA" ma 10:00
 *     i 22 dni; wolimy to niż sondowanie wszystkiego, co ma zakres i godzinę.
 *
 * POMIAR (events.json 2026-08-18, 234 wydarzenia): zakresów dłuższych niż 7 dni bez rytmu
 * jest 18 (7.7%), z tego 17 bez godziny. Festiwale i zjazdy mieszczą się w 2–7 dniach —
 * powyżej nie ma już ani jednego wpisu, który byłby jednym wydarzeniem. Za to są programy
 * („SIERPIEŃ 2026 W ZAMKU", „SIERPIEŃ W OŚRODKU KULTURY", „Akcja Lato z Biblioteką",
 * „LATO W BIBLIOTECE 2026", „Seniorzy w akcji") i wystawy czynne miesiącami.
 *
 * CO ROBIMY: sondujemy adres wpisu tym samym mechanizmem followupów, który już mamy —
 * z jego cache'em po haszu treści, ścieżką blokową i limitem na źródło. Razem z treścią
 * jedzie ZAKRES Z KARTY (`probeContext`) i to on jest właściwym ładunkiem sondy, nie sam
 * fetch: bez niego pierwsza próba na tej podstronie dała 5 wydarzeń z ramki „INNE WYDARZENIA"
 * i zero zajęć programu. Gdy pod adresem
 * naprawdę stoi program, wraca z niego kilka wydarzeń z godzinami, a parasol znika
 * (`dropUmbrellas`). Gdy nie stoi — wpis zostaje taki, jaki był, a sonda kosztowała jedno
 * pobranie i tyle. To jest cała asymetria tej decyzji: fałszywa sonda to fetch, którego
 * jutro nawet nie powtórzymy (ten sam hash = wynik z cache'a, zero wywołań modelu),
 * a fałszywe przepuszczenie to dziesięć zajęć, których nikt nigdy nie zobaczy.
 *
 * CZEGO TA REGUŁA NIE UMIE. Rytmy z tej strony („II wtorek miesiąca", „I środa miesiąca")
 * nie mają zapisu w polu `repeat`, które zna wyłącznie „codziennie" i dni tygodnia —
 * więc zajęcia od września wrócą stamtąd jako pojedyncze terminy albo nie wrócą wcale.
 * Wakacyjne (poniedziałki, wtorki, środy) mieszczą się bez zmian.
 */
import { P } from "../../config/index.js";
import { urlKey } from "../../shared/url.js";
import type { ContainerStats, EventItem, PipelineState } from "../../types/index.js";

import { repertoireSegment } from "../repertoire.js";

const DAY_MS = 86_400_000;

/**
 * Ile wydarzeń spod jednego adresu robi z niego PROGRAM.
 *
 * Dwa, nie jedno, i to jest cały bezpiecznik: strona pojedynczego wydarzenia opisuje samą
 * siebie, więc sonda prawie zawsze oddaje z niej jeden wpis — ten sam, od którego wyszliśmy.
 * Skasowanie parasola na tej podstawie znaczyłoby „zamieniliśmy wpis na jego kopię".
 */
const MIN_CHILDREN = 2;

/** Rozpiętość zakresu w dniach, licząc oba końce; `null`, gdy daty nie są datami. */
function spanDays(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

/**
 * Rozpiętość wpisu O KSZTAŁCIE KONTENERA albo `null`, gdy kształt się nie zgadza.
 *
 * Zwracamy liczbę dni, a nie `true`, bo to ona idzie potem do śladu: notka „36 dni bez rytmu"
 * mówi, co zadecydowało, a „podejrzany o kontener" nie mówi nic.
 */
export function containerSpan(ev: EventItem): number | null {
  if (!ev.date_end || ev.repeat || ev.dates?.length || ev.time_start) return null;
  return spanDays(ev.date_start, ev.date_end);
}

/** Wpis o kształcie kontenera przy dzisiejszym progu; `minSpan <= 0` wyłącza regułę. */
export function isContainerSuspect(ev: EventItem, minSpan: number): boolean {
  if (minSpan <= 0) return false;
  const n = containerSpan(ev);
  return n !== null && n >= minSpan;
}

/** Host bez `www.`; `null` dla adresu, którego nie da się rozłożyć (followup podany względnie). */
function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Ten sam serwis: równe hosty albo poddomena tego samego (bip.lubon.pl ↔ lubon.pl).
 *
 * Poddomenę wpuszczamy, bo urzędy trzymają część treści na `bip.`, a to nadal ta sama
 * instytucja i ten sam właściciel adresu. Obcego hosta NIE wpuszczamy — z tego samego
 * powodu, dla którego nie wpuszcza go prompt (TODO §8a): sondowanie cudzych serwisów
 * to koszt bez granicy, a sygnał był tylko o naszym.
 */
function sameSite(a: string, b: string): boolean {
  const x = hostOf(a), y = hostOf(b);
  if (x === null || y === null) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Adres do sondy albo `null`. Odrzucamy po kolei: brak adresu, adres względny, adres samej
 * strony źródła (nie ma czego dociągać — jej wydarzenia już mamy), repertuar (patrz
 * pipeline/repertoire.ts) i obcy serwis.
 */
function probeUrl(ev: EventItem, pageUrl: string): string | null {
  const u = ev.source_url;
  if (!u || !/^https?:\/\//i.test(u)) return null;
  if (urlKey(u) === urlKey(pageUrl)) return null;
  if (repertoireSegment(u) !== null) return null;
  return sameSite(u, pageUrl) ? u : null;
}

/** Podejrzany adres razem z tym, co o nim wiadomo — notka śladu i kontekst powstają z tych pól. */
export interface ContainerProbe {
  url: string;
  title: string;
  /** rozpiętość zakresu w dniach — to ona uruchomiła sondę */
  days: number;
  /** granice zakresu z KARTY; na stronie programu tych dat najczęściej nie ma wcale */
  from: string;
  to: string;
}

/**
 * Zdanie, które jedzie do modelu razem z treścią podstrony.
 *
 * To jest właściwy ładunek całej sondy, nie sam fetch. Zmierzone na „Seniorzy w akcji"
 * (okpoznan.pl, 2026-08-18): strona opisuje zajęcia wyłącznie rytmem („Zajęcia odbywają się
 * w poniedziałki nad Maltą w godzinach 12:00 – 13:30"), a jedyna data graniczna stoi na
 * karcie, z której przyszliśmy. Bez tego zdania model stosuje „bez konkretnego date_start
 * nie dodawaj wpisu" i oddaje z tej strony ZERO zajęć — pierwsza sonda dała 5 wydarzeń,
 * wszystkie z ramki „INNE WYDARZENIA" na dole strony.
 */
export const probeContext = (p: ContainerProbe): string =>
  `Ta podstrona to program wydarzenia „${p.title}", które trwa od ${p.from} do ${p.to}. `
  + "Zajęcia opisane na niej rytmem, ale bez własnych dat, mieszczą się w tym zakresie.";

export interface ProbePlan {
  probes: ContainerProbe[];
  /** wpisy o kształcie kontenera w ogóle — także te bez adresu do sondy */
  suspects: number;
}

/**
 * Co sondujemy w tym przebiegu.
 *
 * KOLEJNOŚĆ jest tu mechanizmem, nie porządkiem: adresy nigdy niepobrane idą przed tymi,
 * które mają już wpis w cache'u followupów (`at` rośnie z czasem, a pusty napis sortuje się
 * przed każdą datą). Źródło z sześcioma podejrzanymi przerabia je więc w dwa przebiegi
 * zamiast wiecznie mielić trzech pierwszych — a potem wraca do najstarszego, bo strona,
 * która dziś nie miała programu, może go mieć za miesiąc. Stan „raz sprawdzone, nigdy
 * więcej" byłby tu tym samym błędem, co „raz zablokowana grupa, na zawsze wyciszona".
 */
export function planProbes(
  events: EventItem[], ctx: { pageUrl: string; state: PipelineState; taken: string[] },
): ProbePlan {
  const minSpan = P.CONTAINER_MIN_SPAN_DAYS.get();
  const taken = new Set(ctx.taken.map(urlKey));
  const byUrl = new Map<string, ContainerProbe>();
  let suspects = 0;
  for (const ev of events) {
    if (!isContainerSuspect(ev, minSpan)) continue;
    suspects += 1;
    const url = probeUrl(ev, ctx.pageUrl);
    if (url === null) continue;
    const key = urlKey(url);
    if (taken.has(key) || byUrl.has(key)) continue;
    byUrl.set(key, {
      url, title: ev.title, days: containerSpan(ev) ?? 0,
      from: ev.date_start, to: ev.date_end ?? ev.date_start,
    });
  }
  const lastProbe = (u: string): string => ctx.state.extractions?.[urlKey(u)]?.at ?? "";
  const probes = [...byUrl.values()]
    .sort((a, b) => lastProbe(a.url).localeCompare(lastProbe(b.url)) || b.days - a.days)
    .slice(0, Math.max(P.CONTAINER_MAX_PROBES.get(), 0));
  return { probes, suspects };
}

/** Parasol usunięty przez program, który pod nim stał — wejście do śladu. */
export interface Umbrella {
  ev: EventItem;
  url: string;
  children: number;
}

/**
 * Usunięcie parasoli, pod którymi znalazł się program.
 *
 * Liczymy DZIECI: wydarzenia spod tego samego adresu, które same nie mają kształtu kontenera.
 * Dopiero od `MIN_CHILDREN` uznajemy, że sonda przyniosła program, i wtedy kasujemy WSZYSTKIE
 * parasole z tym adresem — także ten, który sonda odczytała po raz drugi z nagłówka strony
 * programu. Bez tego zdania mielibyśmy dwie kopie tego samego bezużytecznego wpisu zamiast
 * jednej, bo dedupe scala je dopiero po tytule i dacie, a tu chodzi o adres.
 */
export function dropUmbrellas(
  events: EventItem[], probed: readonly string[],
): { kept: EventItem[]; dropped: Umbrella[] } {
  const minSpan = P.CONTAINER_MIN_SPAN_DAYS.get();
  const children = new Map<string, number>();
  for (const key of probed.map(urlKey)) children.set(key, 0);
  for (const ev of events) {
    const key = urlKey(ev.source_url ?? "");
    const seen = children.get(key);
    if (seen !== undefined && !isContainerSuspect(ev, minSpan)) children.set(key, seen + 1);
  }

  const dropped: Umbrella[] = [];
  const kept = events.filter((ev) => {
    if (!isContainerSuspect(ev, minSpan)) return true;
    const key = urlKey(ev.source_url ?? "");
    const n = children.get(key) ?? 0;
    if (n < MIN_CHILDREN) return true;
    dropped.push({ ev, url: ev.source_url ?? "", children: n });
    return false;
  });
  return { kept, dropped };
}

/** Rozliczenie sondy — zera też zapisujemy, bo „nic nie sondowaliśmy" to inna wiadomość niż „sonda nic nie dała". */
export function containerStats(
  plan: ProbePlan, dropped: Umbrella[], gained: number,
): ContainerStats {
  return {
    suspects: plan.suspects,
    probed: plan.probes.length,
    resolved: new Set(dropped.map((d) => urlKey(d.url))).size,
    events: gained,
    dropped: dropped.length,
  };
}
