/**
 * Cache ekstrakcji per BLOK treści oraz odsiew wydarzeń minionych.
 *
 * Dwie rzeczy trzymane razem, bo są jedną decyzją. Cache po bloku działa tylko wtedy, gdy
 * wynik modelu zależy WYŁĄCZNIE od treści bloku — a prompt ekstrakcji zaczyna się od „Dziś
 * jest {data}", więc nie zależy. Zamiast usuwać datę z promptu (i tracić rozpoznawanie roku
 * przy „5 sierpnia" oraz zwrotów w rodzaju „w najbliższą sobotę") przyjmujemy, że wpis
 * w cache'u niesie datę SPRZED, i naprawiamy dwa skutki tego wyboru:
 *
 *   1. ODSIEW PRZY ODCZYCIE. Wydarzenie minione wraca z cache'a, ale ma datę, więc wypada
 *      w potoku — dokładnie tak, jak w ścieżce maszynowej (from-capability.ts) i w cache'u
 *      wydarzeń FB (fb-events.ts). Ścieżka modelowa była jedyną, która ufała w tej sprawie
 *      promptowi.
 *
 *   2. UNIEWAŻNIENIE PO PRZETERMINOWANIU. Groźny jest nie błąd daty, tylko CICHE ZNIKNIĘCIE:
 *      blok „Jarmark Świąteczny — 12 grudnia" bywa co roku bajt w bajt taki sam. Zapisany
 *      w 2026 daje 2026-12-12; w 2027 trafiłby w cache, wypadł jako miniony i wydarzenie
 *      zniknęłoby, choć się odbywa. Cache po blokach nasila to, bo mały blok przeżywa lata,
 *      a hash całej strony nie przeżywał tygodnia. Dlatego: wpis, którego WSZYSTKIE wydarzenia
 *      już minęły, jest nieważny i blok idzie do modelu jeszcze raz.
 *
 * Stąd `blocks` trzyma wydarzenia NIEODSIANE — po odsiewie „wszystkie minęły" byłoby nie do
 * odróżnienia od „blok nigdy nic nie dał".
 */
import { audit } from "../../shared/audit.js";
import { daysBetween, todayIso } from "../../shared/dates.js";
import type { CachedBlock, EventItem, PipelineState } from "../../types/index.js";

/** Blok bez wydarzeń przestaje być wiarygodny po tylu dniach — może serwis coś dopisał. */
const EMPTY_TTL_DAYS = 14;
/** Bloki niewidziane od tylu dni wypadają z state.json, żeby plik nie puchł w nieskończoność. */
const KEEP_DAYS = 30;

/**
 * Ostatni dzień wydarzenia. NIGDY samo `date_start` — seria „czerwiec–sierpień" ma start
 * w przeszłości już w lipcu i odsiew po starcie wyciąłby ją w trakcie trwania.
 *
 * `dates` idzie PRZED `date_end`, bo to dwa różne kształty i tylko jeden z nich ma zakres:
 * seria niesie jawną listę terminów i `date_end: null` (patrz types/event.ts), więc czytanie
 * samego `date_end` skróciłoby ją do pierwszego terminu i odsiew wyciąłby żywą serię w dniu
 * jej drugiego spotkania. To jedyne miejsce, w którym „ostatni dzień" jest zdefiniowany —
 * from-capability.ts i fb-events.ts liczyły to kiedyś same.
 */
export const lastDay = (ev: EventItem): string =>
  ev.dates?.[ev.dates.length - 1] ?? ev.date_end ?? ev.date_start;

/**
 * Wydarzenia WYJĘTE z cache'a, odczepione od niego kopią.
 *
 * Trzecia poprawka do „cache niesie datę sprzed" (dwie pierwsze w nagłówku), i jedyna, która
 * chroni cache od strony potoku, a nie odwrotnie: cache oddawał własne obiekty, a potok mutuje
 * wydarzenia w miejscu — `foldSeries` dopisuje `dates` (świadomie, po tożsamości obiektu
 * rozpoznają je `producedBy` i redakcja PII), `attachGeo` dopisuje `geo`. Mutacja wracała więc
 * do state.json i cache przestawał być zapisem tego, co powiedział model.
 *
 * Zmierzone na „Joga na trawie" (gosir-dopiewo, 2026-08): każdy przebieg promował w cache'u
 * jeden kolejny rekord na głowę serii, a taki rekord nie wraca już do zwijania. Przez cztery
 * przebiegi z jednego wydarzenia zrobiły się cztery — po jednym duplikacie na przebieg.
 */
export const detach = (events: EventItem[]): EventItem[] => structuredClone(events);

/**
 * Odsiew minionych. Zwraca też ILE odpadło — sam wynik nie odróżnia „serwis nic nie ma"
 * od „wszystko, co miał, już się odbyło", a to dwie różne diagnozy dla jałowego źródła.
 */
export function dropPast(
  events: EventItem[], today = todayIso(),
): { kept: EventItem[]; dropped: number } {
  const kept = events.filter((ev) => lastDay(ev) >= today);
  return { kept, dropped: events.length - kept.length };
}

/**
 * Wpis z cache'a, albo null gdy trzeba czytać na nowo.
 *
 * `null` z trzech powodów i każdy jest inny: bloku nie ma, wszystkie jego wydarzenia minęły
 * (patrz nagłówek), albo blok od dawna nic nie dawał i wypada mu TTL.
 */
export function lookupBlock(
  state: PipelineState, hash: string, today: string,
): CachedBlock | null {
  const entry = state.blocks?.[hash];
  if (!entry) return null;
  if (entry.events.length) {
    return entry.events.every((ev) => lastDay(ev) < today) ? null : entry;
  }
  return daysBetween(entry.at, today) > EMPTY_TTL_DAYS ? null : entry;
}

/** Odnotowanie, że blok nadal stoi na stronie — bez tego przycinanie skasowałoby żywy wpis. */
export function touchBlock(state: PipelineState, hash: string, today: string): void {
  const entry = state.blocks?.[hash];
  if (entry) entry.seen = today;
}

/** Zapis do cache'a bierze KOPIĘ z tego samego powodu, z którego odczyt ją oddaje (patrz `detach`). */
export function storeBlock(
  state: PipelineState, hash: string, got: { events: EventItem[]; followups: string[] }, today: string,
): void {
  (state.blocks ??= {})[hash] = { ...got, events: detach(got.events), at: today, seen: today };
}

/**
 * Przycięcie cache'a bloków. state.json leży w repo, a bloków przybywa z każdą zmianą
 * na każdej stronie — bez tego plik rośnie monotonicznie i nigdy nie maleje.
 */
export function pruneBlocks(state: PipelineState, today = todayIso()): number {
  if (!state.blocks) return 0;
  let dropped = 0;
  for (const [hash, entry] of Object.entries(state.blocks)) {
    if (daysBetween(entry.seen, today) > KEEP_DAYS) {
      delete state.blocks[hash];
      dropped += 1;
    }
  }
  if (dropped) {
    audit("block", `${dropped} bloków niewidzianych od ${KEEP_DAYS} dni wypadło z cache`,
      { dropped, kept: Object.keys(state.blocks).length });
  }
  return dropped;
}
