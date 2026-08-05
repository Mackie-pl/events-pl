/**
 * Kontrakt opublikowanych wydarzeń na ŻYWYCH danych: co leży w `events.json` po ostatnim
 * przebiegu, a leżeć nie powinno.
 *
 * Na 2026-08-04 leżały tam dwa turnusy półkolonii — jeden ze ścieżki modelu (dopiewo-gosir),
 * drugi z kalendarza `tribe` (dk-pod-lipami). Zgodnie z zasadą tego zestawu nie kasujemy ich
 * ręcznie z pliku: asercja nazywa regułę, `pipeline/camps.ts` ją egzekwuje, a test zzielenieje
 * dopiero po przebiegu `daily` na tym kodzie.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isCamp } from "../../src/pipeline/camps.js";
import { foldSeries } from "../../src/pipeline/series.js";

import { eventsFile, report } from "./helpers.js";

const events = eventsFile()?.events ?? [];

describe("events.json — co nie ma prawa być wydarzeniem", () => {
  it("nie zawiera półkolonii", { skip: !events.length }, () => {
    const offenders = events
      .filter(isCamp)
      .map((ev) => `${ev.source_id ?? "?"}: „${ev.title}" (${ev.date_start})`);

    assert.equal(offenders.length, 0, report(
      "turnus półkolonii opublikowany jako wydarzenie",
      offenders,
      "`withoutCamps()` odsiewa je w `daily.ts` tuż przed dedupe — rekord w pliku znaczy albo " +
      "przebieg sprzed tej zmiany, albo pisownię, której nie łapie wzorzec w `pipeline/camps.ts`.",
    ));
  });

  /**
   * Pytamy tą samą funkcją, którą potok zwija serie — nie własną heurystyką. Druga
   * implementacja „co to znaczy ten sam wpis" mierzyłaby coś innego niż to, co naprawdę
   * zaszło, i doradzałaby poprawki na podstawie scaleń, których potok nigdy nie zrobił.
   * Na wpisach już zwiniętych (mają `date_end`) foldSeries nie robi nic, więc test jest
   * idempotentny.
   */
  it("nie zawiera powtórzeń tego samego wpisu w kolejnych dniach", { skip: !events.length }, () => {
    const offenders = foldSeries(events).dropped
      .map((d) => `${d.loser.source_id ?? "?"}: „${d.loser.title}" (${d.loser.date_start})`);

    assert.equal(offenders.length, 0, report(
      "ten sam wpis opublikowany osobno dla każdego terminu",
      offenders,
      "`foldSeries()` zwija je w `daily.ts` zaraz po dedupe, w jeden rekord z listą `dates`. " +
      "Rekordy w pliku znaczą przebieg sprzed tej zmiany albo różnicę w polu, którego " +
      "`VOLATILE` w `pipeline/series.ts` nie uznaje za zmienne w obrębie serii.",
    ));
  });
});
