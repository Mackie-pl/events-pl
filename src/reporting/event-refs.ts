/**
 * Przypisanie konkretnych wydarzeń do źródeł w raporcie przebiegu.
 *
 * Raport znał dotąd wyłącznie liczby, więc pytanie „co dokładnie dało to źródło w tym
 * przebiegu?" dawało się odpowiedzieć tylko dla NAJNOWSZEGO dnia (filtrem po events.json)
 * i tylko dla rekordów, które przeżyły dedupe. Refy zamykają obie luki.
 */
import { newStats, redactEvent } from "../pipeline/pii.js";
import { eventKey } from "../shared/event-key.js";
import type { EventItem, EventRef, SourceRun } from "../types/index.js";

/** Rekord, którym dany rekord ostatecznie został: idziemy po `winner` aż do końca łańcucha.
 *
 *  Jeden krok nie wystarczy, bo scalenia się składają: kopia serii z drugiej grupy przegrywa
 *  najpierw dedupe na swoim dniu, a dopiero ten zwycięzca zwija się w rytm. Limit obrotów
 *  jest bezpiecznikiem na cykl w danych — raport ma się nie zawiesić na tym, że dwa rekordy
 *  wskazują wzajemnie siebie; wtedy po prostu zostajemy przy ostatnim, do którego doszliśmy. */
function finalWinner(ev: EventItem, winners: Map<EventItem, EventItem>): EventItem {
  let cur = ev;
  for (let hops = 0; hops < 100; hops++) {
    const next = winners.get(cur);
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Wpisuje `produced` do każdego SourceRun, który coś wyprodukował.
 *
 * Wołane PO dedupe (inaczej nie wiadomo, kto przegrał) i po redakcji `allEvents`.
 * Przegrani dedupe nie są w `allEvents`, więc tamta redakcja ich nie objęła — a ich tytuły
 * lecą do runs.json, czyli do publicznego repo. Redagujemy je tutaj: redakcja jest
 * idempotentna, więc powtórka na rekordach już zredagowanych niczego nie psuje.
 */
export function attachProduced(
  byRun: Map<SourceRun, EventItem[]>,
  // minimalny kształt, nie DedupeDrop: raport pyta wyłącznie „kto wsiąkł w kogo", a wchodzą
  // tu dwa różne rodzaje scalenia (dedupe i zwijanie serii), które POWODU nie opisują tak samo
  dropped: readonly { loser: EventItem; winner: EventItem }[],
): void {
  const mergedInto = new Map<EventItem, string>();
  const winners = new Map<EventItem, EventItem>();
  for (const d of dropped) {
    mergedInto.set(d.loser, d.winner.source_id ?? "?");
    winners.set(d.loser, d.winner);
  }
  // statystyki celowo wyrzucane: te trafienia dotyczą rekordów, które nie idą do publikacji,
  // więc doliczone do totals.redacted* zawyżałyby bilans redakcji o duplikaty
  const stats = newStats();

  for (const [run, events] of byRun) {
    if (!events.length) continue;
    run.produced = events.map((ev) => {
      redactEvent(ev, stats);
      const ref: EventRef = { title: ev.title, date: ev.date_start, url: ev.source_url };
      const winner = mergedInto.get(ev);
      if (winner) ref.mergedInto = winner;
      // zwycięzcy są już zredagowani (redactEvents na allEvents leci przed tym wywołaniem),
      // więc klucz liczy się z tych samych tytułów, co po stronie potoku
      const final = finalWinner(ev, winners);
      if (final !== ev) ref.key = eventKey(final.title, final.date_start);
      return ref;
    });
  }
}
