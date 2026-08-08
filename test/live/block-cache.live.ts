/**
 * Kontrakt cache'a bloków na ŻYWEJ stronie: czy znany blok naprawdę NIE idzie do modelu.
 *
 * Testy jednostkowe sprawdzają reguły (odsiew minionych, unieważnianie przeterminowanych,
 * sumę po blokach) na atrapach. Tego jednego nie da się tam sprawdzić, bo cała oszczędność
 * zależy od tego, czy hash bloku policzony z ŻYWEGO HTML-a zgadza się z tym, który zapisaliśmy
 * — a to zależy od html-to-text, od podziału po DOM-ie i od samokontroli naraz. Pierwsza wersja
 * podziału renderowała karty osobno i hasze nie zgadzały się NIGDY; testy jednostkowe były
 * wtedy zielone, a cache nie trafiał ani razu.
 *
 * Test NIE WYWOŁUJE MODELU i nie może: zasiewamy cache atrapami wydarzeń, po czym sprawdzamy,
 * że przebieg policzył zero wywołań. Wywołanie modelu jest tu objawem błędu, nie kosztem.
 *
 *   npm run test:live
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchPlain } from "../../src/adapters/page-fetch.js";
import { suppressArchive } from "../../src/adapters/supabase-archive.js";
import { segmentHtml } from "../../src/pipeline/extract/dom-blocks.js";
import { storeBlock } from "../../src/pipeline/extract/block-cache.js";
import { processSource } from "../../src/pipeline/extract/process-source.js";
import { todayIso } from "../../src/shared/dates.js";
import { sourcesStore } from "../../src/storage/index.js";
import type { PipelineError, PipelineState, Source } from "../../src/types/index.js";

import { event } from "../helpers.js";

const SOURCE_ID = "estrada";
const today = todayIso();
/** Data z zapasem, żeby atrapy nie wypadły przez odsiew minionych i nie udawały pustego cache'a. */
const future = new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10);

async function source(): Promise<Source | undefined> {
  try {
    return (await sourcesStore.load()).sources.find((s) => s.id === SOURCE_ID);
  } catch {
    return undefined;
  }
}

const src = await source();

describe("cache bloków na żywej stronie", { skip: src ? false : "brak źródła w rejestrze" }, () => {
  it("zasiany cache zdejmuje WSZYSTKIE wywołania modelu", async () => {
    const url = src!.url.replace("{page}", "1");
    const fetched = await fetchPlain(url);
    assert.ok(fetched.html, "źródło miało oddać HTML — bez niego nie ma czego dzielić");

    const seg = segmentHtml(fetched.html);
    assert.ok(seg.blocks.length >= 2, `spodziewane ≥2 bloki, było ${seg.blocks.length}`);

    // zasiew: każdy blok dostaje jedno przyszłe wydarzenie, żeby wpis był ważny przy odczycie
    const state: PipelineState = { hashes: {}, geo: {} };
    for (const b of seg.blocks) {
      storeBlock(state, b.hash, { events: [event({ date_start: future })], followups: [] }, today);
    }

    suppressArchive(true);
    const errors: PipelineError[] = [];
    let run;
    try {
      ({ run } = await processSource(src!, state, errors, new Set<string>()));
    } finally {
      suppressArchive(false);
    }

    assert.equal(run.llm.calls, 0,
      `strona z zasianym cache'em nie ma prawa wołać modelu, a wołała ${run.llm.calls} razy — ` +
      "hasze bloków z żywego HTML-a nie zgadzają się z zapisanymi");
    assert.equal(run.blocks?.fresh, 0, "żaden blok nie powinien być nowy");
    assert.equal(run.blocks?.cached, run.blocks?.total, "wszystkie bloki miały wrócić z cache");
  });
});
