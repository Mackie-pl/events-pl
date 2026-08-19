/**
 * Kolejka followupów: deficyt przed kompletem i pamięć adresów identycznych ze stroną.
 *
 * Przypadek prowadzący jest prawdziwy i policzony na `runs.json` / `state.json` z przebiegu
 * 2026-08-19, źródło `mosina-pl-wydarzenia`. Model wskazał pięć podstron, ostatnią z nich
 * `…/pippi-langstrumpf-zwiedza-swiat`; wejście z etapu 1 (`…/wydarzenia?page=1`) doklejone
 * na początek wypchnęło ją poza limit, a samo wróciło jako `same-as-page` — bajt w bajt ta
 * sama treść, zero wydarzeń. Do rejestru weszła z tego karta bez miejsca i bez godziny,
 * podczas gdy dwa pobrane „Zebranie Wiejskie Sołectwa…" miały świetlicę i termin już
 * na listingu (i dały 12 linii `dedupe.dropped` — same duplikaty).
 *
 * Adresy w tym pliku są dosłowne z tamtego przebiegu, żeby za miesiąc dało się sprawdzić,
 * czy przypadek jeszcze istnieje.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  knownSameAsPage, queueFollowups, rememberSameAsPage,
} from "../src/pipeline/extract/followup-queue.js";
import type { PipelineState } from "../src/types/index.js";

import { event } from "./helpers.js";

const LISTA = "https://www.mosina.pl/wydarzenia";
const PAGE1 = "https://www.mosina.pl/wydarzenia?page=1";
const PIPPI = "https://www.mosina.pl/wydarzenia/pippi-langstrumpf-zwiedza-swiat";
const KROSNO = "https://www.mosina.pl/wydarzenia/zebranie-wiejskie-solectwa-krosno-10";
const DASZEWICE = "https://www.mosina.pl/wydarzenia/zebranie-wiejskie-solectwa-daszewice-22";

const st = (): PipelineState => ({ hashes: {}, geo: {} });

/** Karta z listingu tak, jak weszła do events.json: data jest, miejsca i godziny nie ma. */
const pippi = () => event({
  title: "Pippi Langstrumpf zwiedza świat",
  date_start: "2026-08-20", date_end: "2026-08-20", town: "Krosno", source_url: PIPPI,
});

/** Zebranie: świetlica i godzina stoją już na karcie, więc podstrona nic nie wnosi. */
const zebranie = (url: string) => event({
  title: "Zebranie Wiejskie Sołectwa Krosno",
  date_start: "2026-09-02", time_start: "18:00",
  venue: "Świetlica Wiejska", town: "Krosno", source_url: url,
});

describe("deficyt przed kompletem", () => {
  it("podstrona wpisu bez miejsca i godziny wchodzi przed podstronę wpisu kompletnego", () => {
    const out = queueFollowups([KROSNO, DASZEWICE, PIPPI], {
      srcId: "mosina-pl-wydarzenia", state: st(), today: "2026-08-20",
      events: [zebranie(KROSNO), zebranie(DASZEWICE), pippi()],
    });
    assert.equal(out[0], PIPPI, "POTOK: kolejka followupów ma sortować po brakach (venue/time_start)");
  });

  it("brakuje SAMEJ godziny — to nadal deficyt, miejsce bez terminu nie wystarczy", () => {
    const bezGodziny = event({ venue: "Świetlica Wiejska", source_url: PIPPI });
    const out = queueFollowups([KROSNO, PIPPI], {
      srcId: "s", state: st(), today: "2026-08-20", events: [zebranie(KROSNO), bezGodziny],
    });
    assert.equal(out[0], PIPPI);
  });

  it("sort jest STABILNY: przy równym deficycie zostaje kolejność modelu", () => {
    const out = queueFollowups([KROSNO, DASZEWICE, PIPPI], {
      srcId: "s", state: st(), today: "2026-08-20",
      events: [pippi(), zebranie(KROSNO), zebranie(DASZEWICE)].map(
        (ev) => ({ ...ev, venue: "", time_start: null }),
      ),
    });
    assert.deepEqual(out, [KROSNO, DASZEWICE, PIPPI],
      "POTOK: propozycja modelu niesie sygnał — bez powodu nie wolno jej przestawiać");
  });

  it("adres bez ani jednego wpisu w wydarzeniach strony nie awansuje", () => {
    const out = queueFollowups([PIPPI, "https://www.mosina.pl/wydarzenia/nieznany"], {
      srcId: "s", state: st(), today: "2026-08-20", events: [pippi()],
    });
    assert.equal(out[0], PIPPI);
  });
});

describe("pamięć „to ta sama strona\"", () => {
  it("adres potwierdzony jako identyczny nie zajmuje miejsca w kolejce", () => {
    const state = st();
    rememberSameAsPage(PAGE1, "mosina-pl-wydarzenia", state, "2026-08-19");
    const out = queueFollowups([PAGE1, PIPPI], {
      srcId: "mosina-pl-wydarzenia", state, today: "2026-08-20", events: [pippi()],
    });
    assert.deepEqual(out, [PIPPI],
      "POTOK: same-as-page ma być pamiętane, bo wykrywamy je dopiero PO zużyciu slotu");
  });

  it("werdykt WYGASA — serwis może kiedyś rozdzielić paginację i nikt tego nie zgłosi", () => {
    const state = st();
    rememberSameAsPage(PAGE1, "mosina-pl-wydarzenia", state, "2026-08-19");
    assert.equal(knownSameAsPage(PAGE1, "mosina-pl-wydarzenia", state, "2026-09-01"), true);
    assert.equal(knownSameAsPage(PAGE1, "mosina-pl-wydarzenia", state, "2026-09-30"), false,
      "POTOK: stan „raz zapadł, na zawsze\" jest błędem projektowym");
  });

  it("werdykt jest PER ŹRÓDŁO — ten sam adres bywa u sąsiada zwykłą podstroną", () => {
    const state = st();
    rememberSameAsPage(PAGE1, "mosina-pl-wydarzenia", state, "2026-08-19");
    assert.equal(knownSameAsPage(PAGE1, "inne-zrodlo", state, "2026-08-20"), false);
  });

  it("adres liczy się po urlKey, nie po literach — www i końcowy ukośnik to ten sam zasób", () => {
    const state = st();
    rememberSameAsPage(PAGE1, "s", state, "2026-08-19");
    assert.equal(knownSameAsPage("http://mosina.pl/wydarzenia?page=1", "s", state, "2026-08-20"), true);
  });
});

describe("limit", () => {
  it("kolejka nie przekracza sufitu z konfiguracji", () => {
    const many = Array.from({ length: 20 }, (_, i) => `${LISTA}/x-${i}`);
    const out = queueFollowups(many, { srcId: "s", state: st(), today: "2026-08-20", events: [] });
    assert.ok(out.length > 0 && out.length <= many.length);
    assert.ok(out.every((u, i) => u === many[i]), "bez deficytu kolejność zostaje bez zmian");
  });
});
