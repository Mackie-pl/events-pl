/**
 * Potwierdzenie źródła, które już jest w rejestrze.
 *
 * Regresja, którą to zamyka: trafienie w znany adres kończyło się `decision: "duplicate"`
 * i `continue`. Skutek — 46 źródeł wpisanych ręcznie nie miało ŻADNEJ szansy dorobić się
 * odpowiedzi na „skąd to się tu wzięło", bo każdy kolejny przebieg discovery je pomijał,
 * a rejestr nigdy nie dowiadywał się, że nadal są znajdowane.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { type Confirmation, confirm } from "../src/pipeline/discover/discover-town.js";
import type { SearchResult, Source, SourceProposal } from "../src/types/index.js";

const RUN = "2026-08-01T03:00:00.000Z";

const hit: SearchResult = {
  title: "GOK Luboń — wydarzenia",
  url: "https://gok.test/wydarzenia",
  desc: "kalendarz imprez",
};

const source = (over: Partial<Source> = {}): Source => ({
  id: "gok", name: "GOK", type: "culture_center", url: "https://gok.test/",
  town: "Luboń", fetch: "plain", verified: true, ...over,
});

const proposal = (over: Partial<SourceProposal> = {}): SourceProposal => ({
  id: "gok", name: "GOK", url: "https://gok.test/", town: "Luboń",
  decision: "added", confidence: 0.9, ...over,
});

const ctx = (over: Partial<Confirmation> = {}): Confirmation => ({
  run: RUN, town: "Luboń", matched: { query: "Luboń ośrodek kultury", hit }, why: "kalendarz", ...over,
});

describe("confirm — ślad potwierdzenia", () => {
  it("znane źródło dostaje datę ostatniego znalezienia i zerowy licznik pudeł", () => {
    const src = source({ missedRuns: 3 });
    confirm(src, proposal(), ctx());

    assert.equal(src.lastSeenRun, RUN);
    assert.equal(src.missedRuns, 0);
  });

  it("źródło bez proweniencji dostaje ją z bieżącego trafienia", () => {
    const src = source();
    const p = proposal();
    confirm(src, p, ctx());

    assert.equal(p.decision, "confirmed", "to nie jest odrzucenie — adres właśnie dostał dowód");
    assert.equal(src.provenance?.query, "Luboń ośrodek kultury");
    assert.deepEqual(src.provenance?.hit, hit);
    assert.equal(src.provenance?.run, RUN);
    assert.equal(src.provenance?.why, "kalendarz");
    assert.equal(src.provenance?.confidence, 0.9);
  });

  it("istniejąca proweniencja NIE jest nadpisywana", () => {
    // pierwsze znalezisko jest cenniejsze niż dowolne późniejsze potwierdzenie:
    // mówi, jak źródło trafiło do rejestru, a nie tylko że nadal istnieje
    const src = source({
      provenance: { run: "2026-06-01T00:00:00.000Z", town: "Luboń", model: "stary-model", query: "pierwsze" },
    });
    const p = proposal();
    confirm(src, p, ctx());

    assert.equal(src.provenance?.query, "pierwsze");
    assert.equal(src.provenance?.run, "2026-06-01T00:00:00.000Z");
    assert.equal(p.decision, "duplicate", "nic nie dopisano — to zwykły duplikat");
    assert.equal(src.lastSeenRun, RUN, "ale świeżość i tak odnotowujemy");
  });

  it("trafienie bez dopasowania do wyniku search też daje proweniencję, tylko bez hitu", () => {
    const src = source();
    confirm(src, proposal(), ctx({ matched: null }));

    assert.equal(src.provenance?.query, undefined);
    assert.equal(src.provenance?.hit, undefined);
    assert.equal(src.provenance?.run, RUN, "model to zaproponował, więc ślad i tak powstaje");
  });
});

describe("confirm — powrót zdegradowanego źródła", () => {
  it("ponowne znalezienie zdejmuje `inactive`", () => {
    const src = source({ inactive: true, missedRuns: 2 });
    confirm(src, proposal(), ctx());

    assert.equal(src.inactive, undefined, "degradacja ma być odwracalna bez ręcznej edycji");
    assert.equal(src.missedRuns, 0);
    assert.match(src.notes ?? "", /znowu znalezione/);
  });
});
