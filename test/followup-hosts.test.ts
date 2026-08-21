/**
 * Licznik jałowych obcych serwisów w followupach. Testujemy go, bo pomyłka wycisza CAŁY
 * serwis na miesiąc, a nie jeden wiersz w raporcie — i w obie strony jest cicha: za ostry
 * licznik odbiera nam wejście do prawdziwych podstron, za luźny płaci za katalog wycieczek
 * codziennie i nikt się nie dowie, bo w tabeli to zwykły followup.
 *
 * Przypadek wyjściowy: `st.pl/trip/index` z przebiegu 2026-08-21 — 38 wyciągniętych
 * „wydarzeń”, zero opublikowanych, $0.0104 (drożej niż cała strona źródła).
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import {
  followupHostMuted, noteFollowupEvents, noteFollowupHosts, resetFollowupHosts,
} from "../src/pipeline/extract/followup-hosts.js";
import { beginAuditRun } from "../src/shared/audit.js";
import type { EventItem, FollowupRun, PipelineState, SourceRun } from "../src/types/index.js";

import { event } from "./helpers.js";

const TODAY = "2026-08-21";

const followup = (url: string, kind: FollowupRun["kind"] = "page"): FollowupRun =>
  ({ url, kind, outcome: "ok", events: 38 });

function src(url: string, followups: FollowupRun[]): SourceRun {
  return {
    id: "zrodlo", name: "Źródło", town: "Dopiewo", url, fetch: "plain", status: "ok",
    events: 0, followups, geo: { hits: 0, misses: 0 },
    llm: { calls: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 }, ms: 1,
  };
}

const state = (): PipelineState => ({ hashes: {}, geo: {} });

/**
 * Jeden przebieg: followupy oddają `gave`, a do publikacji wchodzi `published`.
 * Rozdzielenie tych dwóch list JEST przedmiotem testu — followup potrafi oddać 38 rekordów,
 * z których czytelnik zobaczy zero.
 */
function runOnce(
  st: PipelineState,
  opts: { followups: FollowupRun[]; gave?: EventItem[]; published?: EventItem[]; today?: string },
): void {
  resetFollowupHosts();
  for (const fu of opts.followups) noteFollowupEvents(fu.url, fu.kind, opts.gave ?? []);
  noteFollowupHosts({
    runs: [src("https://www.facebook.com/groups/1", opts.followups)],
    published: opts.published ?? [],
    registry: new Set(["dopiewo.pl"]),
    state: st,
    today: opts.today ?? TODAY,
  });
}

const stTrip = (): FollowupRun[] => [followup("https://st.pl/trip")];

beforeEach(() => { beginAuditRun(); resetFollowupHosts(); });

describe("licznik serii", () => {
  it("rośnie, dopóki serwis nic nie publikuje, i dopiero na progu wycisza", () => {
    const st = state();
    for (const day of ["2026-08-19", "2026-08-20"]) runOnce(st, { followups: stTrip(), today: day });
    // dwa jałowe przebiegi to jeszcze nie werdykt — podstrona bywa pusta w poniedziałek
    assert.equal(followupHostMuted("https://st.pl/trip", st, TODAY), null);
    assert.equal(st.followupHosts?.["st.pl"]?.runs, 2);

    runOnce(st, { followups: stTrip() });
    assert.equal(followupHostMuted("https://st.pl/trip", st, TODAY)?.runs, 3);
  });

  it("wycisza CAŁY serwis, nie sam adres — biuro podróży ma tysiąc podstron", () => {
    const st = state();
    for (const day of ["2026-08-19", "2026-08-20", TODAY]) runOnce(st, { followups: stTrip(), today: day });
    assert.ok(followupHostMuted("https://st.pl/inna/oferta?x=1", st, TODAY));
    // „www." to ten sam serwis — inaczej wystarczyłby inny link, żeby obejść licznik
    assert.ok(followupHostMuted("https://www.st.pl/trip", st, TODAY));
  });

  it("jedno OPUBLIKOWANE wydarzenie zeruje serię", () => {
    const st = state();
    for (const day of ["2026-08-19", "2026-08-20"]) runOnce(st, { followups: stTrip(), today: day });
    const koncert = event({ title: "Koncert", source_url: "https://st.pl/trip/koncert" });
    runOnce(st, { followups: stTrip(), gave: [koncert], published: [koncert] });
    assert.equal(st.followupHosts?.["st.pl"], undefined);
  });

  it("liczy PLON PO PUBLIKACJI, a nie rekordy wyciągnięte z followupa", () => {
    // followup mówi „38 wydarzeń", ale żadne nie przeszło odsiewu i scalania — to jest
    // dokładnie ta różnica, przez którą st.pl wyglądał na najlepszy followup przebiegu
    const st = state();
    runOnce(st, {
      followups: stTrip(),
      gave: [event({ title: "Wycieczka do Turcji" })],
      published: [event({ title: "Dożynki" })],
    });
    assert.equal(st.followupHosts?.["st.pl"]?.runs, 1);
  });
});

describe("plon liczymy kluczem wydarzenia, nie adresem", () => {
  it("host liczy się jako plonujący, choć opublikowany rekord wskazuje INNY adres", () => {
    // przypadek z przebiegu 2026-08-21: followup na imd.org.pl oddał wpisy o bawialni,
    // a opublikowane rekordy wskazują POST z grupy FB — bo tam model kazał pójść czytelnikowi.
    // Wersja licząca hosty z `source_url` wyciszyłaby jedyne miejsce, z którego znamy godziny.
    const st = state();
    const fromFollowup = event({ title: "Bawialnia dla młodszych dzieci", date_start: "2026-08-25" });
    const asPublished = event({
      title: "Bawialnia dla młodszych dzieci", date_start: "2026-08-25",
      source_url: "https://www.facebook.com/groups/babacoolpoznan/posts/281669351",
    });
    runOnce(st, {
      followups: [followup("https://imd.org.pl/bawialnia/")],
      gave: [fromFollowup], published: [asPublished],
    });
    assert.equal(st.followupHosts?.["imd.org.pl"], undefined);
  });
});

describe("czego licznik NIE rusza", () => {
  it("podstron własnego serwisu źródła", () => {
    const st = state();
    const own = { ...src("https://mosina.pl/wydarzenia", [followup("https://mosina.pl/wydarzenie/1")]) };
    for (let i = 0; i < 5; i += 1) {
      noteFollowupHosts({ runs: [own], published: [], registry: new Set(), state: st, today: TODAY });
    }
    assert.equal(st.followupHosts?.["mosina.pl"], undefined);
  });

  it("serwisów, które same są w rejestrze źródeł", () => {
    // bibldop-wydarzenia linkuje do dopiewo.pl, który skrobiemy osobno — wyciszenie
    // zabrałoby nam wejście do własnego źródła
    const st = state();
    for (let i = 0; i < 5; i += 1) runOnce(st, { followups: [followup("https://dopiewo.pl/wydarzenia/1")] });
    assert.equal(st.followupHosts?.["dopiewo.pl"], undefined);
  });

  it("plakatów — wydarzenie z plakatu wskazuje POST, więc host obrazu milczy zawsze", () => {
    const st = state();
    for (let i = 0; i < 5; i += 1) {
      runOnce(st, { followups: [followup("https://scontent.xx.fbcdn.net/v/t39/plakat.jpg", "poster")] });
    }
    assert.equal(st.followupHosts?.["scontent.xx.fbcdn.net"], undefined);
  });
});

describe("droga powrotna", () => {
  it("po okresie sondy adres wraca do kolejki", () => {
    const st = state();
    for (const day of ["2026-08-19", "2026-08-20", TODAY]) runOnce(st, { followups: stTrip(), today: day });
    assert.ok(followupHostMuted("https://st.pl/trip", st, "2026-09-19"));
    // 30 dni od ostatniej próby — serwis mógł zacząć publikować i nikt nam tego nie zgłosi
    assert.equal(followupHostMuted("https://st.pl/trip", st, "2026-09-20"), null);
  });

  it("wpis o PRZERWANEJ serii wypada ze state.json — plik jest commitowany", () => {
    const st = state();
    runOnce(st, { followups: stTrip() });
    // inny host miesiąc później: porzucona seria st.pl nie ma już czego pilnować
    runOnce(st, { followups: [followup("https://inny.example/x")], today: "2026-09-21" });
    assert.equal(st.followupHosts?.["st.pl"], undefined);
    assert.equal(st.followupHosts?.["inny.example"]?.runs, 1);
  });

  it("ale wpis WYCISZONY przycinanie omija — to on trzyma wyciszenie przy życiu", () => {
    const st = state();
    for (const day of ["2026-08-19", "2026-08-20", TODAY]) runOnce(st, { followups: stTrip(), today: day });
    runOnce(st, { followups: [followup("https://inny.example/x")], today: "2026-09-19" });
    assert.equal(st.followupHosts?.["st.pl"]?.runs, 3);
    assert.ok(followupHostMuted("https://st.pl/trip", st, "2026-09-19"));
  });
});
