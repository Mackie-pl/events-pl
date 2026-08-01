/**
 * Kontrakt ekstrakcji na ŻYWYCH danych: czy etap 2 sięga tam, gdzie etap 1 znalazł wydarzenia.
 *
 * Etap 1 ustala `entrypoints` — adres, pod którym serwis WYPISUJE wydarzenia — i zapisuje go
 * przy źródle. Przez cały lipiec 2026 etap 2 tego pola nie czytał i pobierał sam `Source.url`,
 * czyli korzeń serwisu: 26 z 41 pobieranych źródeł wchodziło niewłaściwymi drzwiami.
 *
 * Asercja mówi „adres ODWIEDZONY", a nie „adres pobrany jako strona główna źródła",
 * bo pomiar z 2026-08-01 (sam fetch, bez modelu) pokazał, że wymiana korzenia na entrypoint
 * bywa stratą — lubon.pl ma 6 różnych dat na stronie głównej i zero pod `/artykuly/350/wydarzenia`.
 * Entrypoint DOKŁADA się więc do korzenia jako followup, zamiast go zastępować.
 *
 * Ten test przestanie padać dopiero po przebiegu `daily` na kodzie, który to robi.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entryUrl } from "../../src/pipeline/extract/entry-url.js";
import { isFbFetch } from "../../src/shared/url.js";
import { urlKey } from "../../src/shared/url.js";

import { dailyRuns, report, sourcesFile } from "./helpers.js";

const sources = sourcesFile()?.sources ?? [];
const byId = new Map(sources.map((s) => [s.id, s]));
const lastRun = dailyRuns().at(-1);
const fetchedRows = (lastRun?.sources ?? []).filter((s) => !s.status.startsWith("skipped"));

/** Adresy, które przebieg faktycznie odwiedził dla tego źródła: strona + wszystkie followupy. */
const visited = (row: (typeof fetchedRows)[number]): string[] =>
  [row.url, ...row.followups.map((f) => f.url)].map(urlKey);

describe("ekstrakcja — entrypoint z etapu 1 zostaje odwiedzony", () => {
  it("ostatni przebieg daily sięgnął pod entrypoint każdego źródła", { skip: !fetchedRows.length }, () => {
    const offenders = fetchedRows
      .filter((row) => byId.has(row.id))
      .map((row) => ({ row, want: entryUrl(byId.get(row.id)!) }))
      .filter(({ row, want }) => want.entrypoint && !visited(row).includes(urlKey(want.url)))
      .map(({ row, want }) => `${row.id}: odwiedzono ${row.url}, a wydarzenia są pod ${want.url}`);

    assert.equal(offenders.length, 0, report(
      "entrypoint, pod który przebieg w ogóle nie sięgnął",
      offenders,
      "`processSource` dokłada `entryUrl(src)` na początek followupów — rozjazd znaczy albo " +
      "przebieg sprzed tej zmiany, albo entrypoint zapisany PO tym przebiegu (wtedy zejdzie " +
      "sam przy następnym daily).",
    ));
  });

  it("źródło z entrypointem nie kończy z zerem wydarzeń bez śladu awarii", { skip: !fetchedRows.length }, () => {
    // zero wydarzeń przy działającym pobraniu i znanej liście odnośników znaczy, że model
    // dostał niewłaściwą stronę albo lista jest renderowana JS-em — jedno i drugie jest
    // usterką potoku, nie cechą źródła, więc nie wolno go na tej podstawie degradować
    const withLinks = (id: string) => byId.get(id)?.entrypoints?.find((e) => (e.detailCount ?? 0) > 0);
    const offenders = fetchedRows
      .filter((row) => row.status === "empty" && row.events === 0 && (row.chars ?? 0) > 500)
      .filter((row) => withLinks(row.id))
      .map((row) => {
        const e = withLinks(row.id);
        return `${row.id}: 0 wydarzeń z ${row.chars} zn., a entrypoint ma ×${e?.detailCount} odnośników (${e?.url})`;
      });

    assert.equal(offenders.length, 0, report(
      "źródło z listą odnośników, które nie dało ani jednego wydarzenia",
      offenders,
      "dopóki to nie jest zero, „zero wydarzeń” NIE nadaje się na przesłankę degradacji " +
      "źródła — mierzy usterkę potoku, nie martwe źródło. Kolejny krok, gdy ta lista " +
      "opustoszeje: pobieranie podstron z `detailPattern` zamiast samej listy.",
    ));
  });
});

describe("ekstrakcja — źródła FB", () => {
  it("nie mają entrypointów wymuszających zwykły fetch", { skip: !sources.length }, () => {
    // fetch FB idzie przez Bright Data i własną ścieżkę; entrypoint HTTP-owy tylko by mylił
    const offenders = sources
      .filter((s) => isFbFetch(s.fetch) && s.entrypoints?.length)
      .map((s) => `${s.id}: fetch "${s.fetch}", a ma ${s.entrypoints?.length} entrypointów`);

    assert.equal(offenders.length, 0, report(
      "źródło FB z entrypointem",
      offenders,
      "`verifySource` pomija źródła FB przed profilowaniem, więc entrypoint przy takim źródle " +
      "pochodzi z innej ścieżki — znaleźć ją, bo `entryUrl` musi dla FB zwracać `Source.url`.",
    ));
  });
});
