/**
 * Kontrakt przebiegów na ŻYWYCH danych: czy ostatni przebieg zapisał to, co twierdzi.
 *
 * Reguły dotyczą zgodności raportu z rejestrem — raport jest jedynym śladem po przebiegu,
 * który kosztował pieniądze, więc rozjazd między nim a `sources.json` znaczy, że decyzja
 * zapadła i wyparowała.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { urlKey } from "../../src/shared/url.js";

import { latestRun, report, sourcesFile } from "./helpers.js";

const run = latestRun();
const sources = sourcesFile()?.sources ?? [];
const byId = new Map(sources.map((s) => [s.id, s]));

describe("ostatni przebieg discover — zgodność raportu z rejestrem", () => {
  it("każdy werdykt `fixed` niesie nowy adres", { skip: !run }, () => {
    const offenders = (run?.verifications ?? [])
      .filter((v) => v.outcome === "fixed" && !v.newUrl)
      .map((v) => `${v.id}: outcome fixed bez newUrl`);

    assert.equal(offenders.length, 0, report(
      "naprawa bez adresu",
      offenders,
      "`onReachable`/`repair` ustawiają `outcome: \"fixed\"` razem z `newUrl` — brak jednego " +
      "z nich znaczy trzecią ścieżkę, która ustawia sam werdykt.",
    ));
  });

  it("naprawiony adres wylądował w rejestrze", { skip: !run || !sources.length }, () => {
    const offenders = (run?.verifications ?? [])
      .filter((v) => v.newUrl && byId.has(v.id))
      .filter((v) => {
        const current = byId.get(v.id)?.url ?? "";
        // rejestr trzyma szablon z {page}; porównujemy po podstawieniu, bo naprawa origin-u
        // celowo zostawia paginację (patrz `rebase`)
        return urlKey(current.replace("{page}", "1")) !== urlKey(v.newUrl ?? "");
      })
      .map((v) => `${v.id}: raport → ${v.newUrl}, rejestr → ${byId.get(v.id)?.url}`);

    assert.equal(offenders.length, 0, report(
      "naprawa zgłoszona w raporcie, ale nie zapisana w rejestrze",
      offenders,
      "`markAlive` porównuje adresy DOSŁOWNIE, nie przez `urlKey` — jeśli to wystąpiło, " +
      "sprawdzić `rebase()`: zejście z https na http albo zmiana `www.` mogła zostać uznana " +
      "za brak zmiany i cicho nie zapisać się.",
    ));
  });

  it("werdykt `dead` w raporcie ma odpowiednik w rejestrze", { skip: !run || !sources.length }, () => {
    const offenders = (run?.verifications ?? [])
      .filter((v) => v.outcome === "dead" && byId.has(v.id) && !byId.get(v.id)?.dead)
      .map((v) => `${v.id}: raport mówi dead, rejestr nie`);

    assert.equal(offenders.length, 0, report(
      "raport i rejestr nie zgadzają się co do śmierci",
      offenders,
      "jeśli to skutek świadomego zdjęcia `dead` przez późniejszy przebieg — reguła jest zła " +
      "i trzeba porównywać tylko z NAJNOWSZYM przebiegiem dla danego id. W przeciwnym razie " +
      "`markDead` nie doszło do zapisu.",
    ));
  });

  it("pełny przebieg rozlicza rejestr z brakami", { skip: run?.mode !== "full" }, () => {
    const t = run?.totals;
    const accounted = (t?.sourcesConfirmed ?? 0) + (t?.sourcesMissed ?? 0) > 0;

    assert.ok(accounted, report(
      "pełny przebieg bez ani jednego potwierdzenia i ani jednego pudła",
      [`${run?.startedAt}: confirmed=${t?.sourcesConfirmed}, missed=${t?.sourcesMissed}`],
      "`reconcileRegistry` w src/actions/discover.ts woła się tylko dla przebiegów pełnych " +
      "i po pętli gmin — zerowe liczniki przy niepustym rejestrze znaczą, że nie została wywołana.",
    ));
  });
});

describe("ostatni przebieg discover — reset", () => {
  const removed = run?.reset?.removed ?? [];

  it("spis skasowanych jest rozliczony co do sztuki", { skip: !removed.length }, () => {
    const lost = removed.filter((r) => !r.returned && !r.dead);
    // to NIE jest awaria — to wynik pomiaru: adresy, których wyszukiwarka nie odtworzyła.
    // Test pilnuje tylko, żeby rozliczenie w ogóle powstało.
    const unresolved = removed.filter((r) => r.returned === undefined && r.returnedUrl !== undefined);

    assert.equal(unresolved.length, 0, report(
      "wpis w spisie skasowanych bez rozstrzygnięcia",
      unresolved.map((r) => r.id),
      "pętla dopisująca `returned` w `reconcileRegistry` przebiega po `report.reset.removed` — " +
      "wpis z samym `returnedUrl` znaczy, że ktoś ustawił je poza tą pętlą.",
    ));
    if (lost.length) {
      console.log(`  ℹ ${lost.length} adresów nie wróciło po resecie: ${lost.map((r) => r.id).join(", ")}`);
      console.log("    (grupy FB i adresy spoza indeksu — kandydaci na ręczne dodanie do listy startowej)");
    }
  });
});
