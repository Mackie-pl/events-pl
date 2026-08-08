/**
 * Przypisanie konkretnych wydarzeń do źródeł w raporcie przebiegu.
 *
 * Raport znał dotąd wyłącznie liczby, więc pytanie „co dokładnie dało to źródło w tym
 * przebiegu?" dawało się odpowiedzieć tylko dla NAJNOWSZEGO dnia (filtrem po events.json)
 * i tylko dla rekordów, które przeżyły dedupe. Refy zamykają obie luki.
 */
import { newStats, redactEvent } from "../pipeline/pii.js";
import type { EventItem, EventRef, SourceRun } from "../types/index.js";

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
  for (const d of dropped) mergedInto.set(d.loser, d.winner.source_id ?? "?");
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
      return ref;
    });
  }
}
