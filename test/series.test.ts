/**
 * Serie cykliczne. Trzy rzeczy, z których każda psuje się po cichu i w innym miejscu:
 *
 * 1. ROZWIJANIE nie może wymyślić ani jednego terminu. Rytm bez `date_end` albo zapisany
 *    tak, że nie da się go odczytać, MUSI zostawić wpis jednorazowy — wpis niepełny widać,
 *    wpisu fałszywego już nie.
 * 2. ZWIJANIE ma być bezstratne. Rekordy różniące się wyłącznie terminem znoszą się w serię,
 *    ale „Kino letnie … seans: Nomadland" i „… seans: Krudowie 2" różnią się TREŚCIĄ i mają
 *    zostać osobno. Atrapy w tym pliku to prawdziwe rekordy z events.json (2026-08-03).
 * 3. ETYKIETA nie może obiecywać terminów, których nie ma. To jedyne miejsce, w którym
 *    zwięzłość („środy i piątki do 21.08") kusi, żeby skłamać o co drugim tygodniu.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { detach, lastDay } from "../src/pipeline/extract/block-cache.js";
import { expandRepeat, foldSeries } from "../src/pipeline/series.js";
import { auditTrails, beginAuditRun } from "../src/shared/audit.js";
import { MAX_OCCURRENCES, occursIn, parseRepeat, seriesLabel } from "../src/shared/series.js";
import type { EventItem } from "../src/types/index.js";

import { event } from "./helpers.js";

const TODAY = "2026-08-01"; // sobota
const dates = (evs: { date_start: string }[]): string[] => evs.map((e) => e.date_start);

beforeEach(() => { beginAuditRun(); });

describe("parseRepeat — rytm z pola tekstowego", () => {
  it("czyta dni tygodnia w notacji promptu", () => {
    assert.deepEqual(parseRepeat("sb,nd"), { kind: "weekdays", days: [0, 6] });
    assert.deepEqual(parseRepeat("pn,sr,cz"), { kind: "weekdays", days: [1, 3, 4] });
  });

  it("znosi ogonki, wielkie litery i rozwlekłość modelu", () => {
    const expected = { kind: "weekdays", days: [3] };
    for (const raw of ["sr", "śr", "ŚR", "sroda", "środa", " środa "]) {
      assert.deepEqual(parseRepeat(raw), expected, raw);
    }
    assert.deepEqual(parseRepeat("pon, wt, sroda"), { kind: "weekdays", days: [1, 2, 3] });
  });

  it("rozpoznaje codzienność w odmianach", () => {
    for (const raw of ["codziennie", "Codzienne", "codziennie "]) {
      assert.deepEqual(parseRepeat(raw), { kind: "daily" }, raw);
    }
  });

  it("jeden nieczytelny człon unieważnia CAŁY rytm", () => {
    // „same soboty" byłoby cichym wymyśleniem połowy terminów
    assert.equal(parseRepeat("sb, niedziele parzyste"), null);
    assert.equal(parseRepeat("co drugi tydzień"), null);
    assert.equal(parseRepeat(""), null);
  });
});

describe("expandRepeat — rytm na terminy", () => {
  it("rozwija dni tygodnia w zakresie", () => {
    const out = expandRepeat(
      [event({ repeat: "sb,nd", date_start: TODAY, date_end: "2026-08-10" })], TODAY,
    );
    assert.deepEqual(dates(out), ["2026-08-01", "2026-08-02", "2026-08-08", "2026-08-09"]);
    assert.equal(out.every((e) => e.date_end === null), true, "termin serii jest jednodniowy");
  });

  it("rozwija codzienność", () => {
    const out = expandRepeat(
      [event({ repeat: "codziennie", date_start: TODAY, date_end: "2026-08-04" })], TODAY,
    );
    assert.deepEqual(dates(out), ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("bez date_end NIE wymyśla końca zakresu — wpis zostaje jednorazowy", () => {
    const out = expandRepeat([event({ repeat: "sb,nd", date_start: TODAY, date_end: null })], TODAY);
    assert.deepEqual(dates(out), [TODAY]);
    assert.match(auditTrails()[0]?.steps[0]?.note ?? "", /bez date_end/);
  });

  it("nieczytelny rytm zostawia wpis jednorazowy i mówi o tym w śladzie", () => {
    const out = expandRepeat(
      [event({ repeat: "co drugi tydzień", date_start: TODAY, date_end: "2026-08-31" })], TODAY,
    );
    assert.deepEqual(dates(out), [TODAY]);
    assert.match(auditTrails()[0]?.steps[0]?.note ?? "", /nie da się odczytać/);
  });

  it("nierozwinięty rytm NIE zostaje zakresem — inaczej digest wypisze zły dzień", () => {
    // „Mała Zielarnia": rytm „pt,nd", zakres 03.07–12.08, a 12.08 to środa. Zakres czytany
    // przez occursIn jako „trwa bez przerwy" wypisał zajęcia na dzień, w którym ich nie ma.
    const [out] = expandRepeat(
      [event({ repeat: "pt,nd", date_start: "2026-07-03", date_end: "2026-08-12" })], "2026-08-12",
    );

    assert.equal(out?.date_end, null, "zakres rytmu nie jest czasem trwania");
    assert.equal(out?.date_start, "2026-07-03");
    assert.deepEqual(
      occursIn(out, "2026-08-12", "2026-08-12"), [], "nie pokazuje się w środę",
    );
    assert.match(auditTrails()[0]?.steps[1]?.note ?? "", /nie znaczy/);
  });

  it("ostatni termin rytmu ZOSTAJE — odsiewamy zjawy, nie prawdziwe zajęcia", () => {
    // druga „Mała Zielarnia", z innej podstrony tego samego serwisu: rytm „sr", ten sam
    // zakres do 12.08. Ta środa jest prawdziwa i ma się wypisać, choć rytm nie dał serii.
    const [out] = expandRepeat(
      [event({ repeat: "sr", date_start: "2026-08-05", date_end: "2026-08-12" })], "2026-08-12",
    );

    assert.equal(out?.date_start, "2026-08-12", "wpis schodzi na swój jedyny pozostały termin");
    assert.equal(out?.date_end, null);
    assert.deepEqual(occursIn(out, "2026-08-12", "2026-08-12"), ["2026-08-12"]);
  });

  it("rytm bez ani jednego terminu w zakresie zostawia ślad", () => {
    // jedyna gałąź, która milczała — a to ona stała za wpisem wypisanym na zły dzień
    expandRepeat(
      [event({ repeat: "pt,nd", date_start: "2026-07-03", date_end: "2026-08-12" })], "2026-08-12",
    );
    assert.match(auditTrails()[0]?.steps[0]?.note ?? "", /nie ma już ani jednego terminu/);
  });

  it("zdejmuje `repeat` i `dates` — za tą granicą kształt jest rozstrzygnięty", () => {
    // rekord z `repeat` I `dates` naraz to dokładnie ta trucizna, którą zastaliśmy w state.json
    const zatruty = event({
      repeat: "nd", date_start: "2026-08-09", date_end: "2026-08-30",
      dates: ["2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30"],
    });
    const out = expandRepeat([zatruty], TODAY);

    assert.equal(out.every((e) => e.repeat === ""), true, "rytm rozliczony, nie przechodzi dalej");
    assert.equal(out.every((e) => e.dates === undefined), true, "stara lista terminów nie dziedziczy się");
    assert.equal(out.every((e) => e.date_end === null), true);
  });

  it("przycina początek do dziś — plakat na cały sezon przychodzi w jego połowie", () => {
    const out = expandRepeat(
      [event({ repeat: "sb", date_start: "2026-06-20", date_end: "2026-08-15" })], TODAY,
    );
    assert.deepEqual(dates(out), ["2026-08-01", "2026-08-08", "2026-08-15"]);
  });

  it("nie przekracza sufitu rozwinięcia", () => {
    const out = expandRepeat(
      [event({ repeat: "codziennie", date_start: TODAY, date_end: "2027-08-01" })], TODAY,
    );
    assert.equal(out.length, MAX_OCCURRENCES);
    assert.match(auditTrails()[0]?.steps[0]?.note ?? "", /więcej niż 60/);
  });

  it("nie rusza wpisów bez rytmu i nie zaśmieca śladu", () => {
    const jednorazowe = event({ date_start: TODAY });
    assert.deepEqual(expandRepeat([jednorazowe], TODAY), [jednorazowe]);
    assert.deepEqual(auditTrails(), []);
  });
});

/** Prawdziwe rekordy z events.json (2026-08-03) — różnią się tylko datą i adresem terminu. */
const zajecia = (date: string, slug: string) => event({
  title: "ZAJĘCIA STAŁE W ODK „BAJKA”",
  date_start: date,
  venue: "Osiedlowy Dom Kultury „Bajka”",
  town: "Poznań",
  tags: ["tribe:wydarzenie"],
  source_url: `https://psmwinogrady.pl/wydarzenie/${slug}/`,
  source_id: "dk-pod-lipami",
});

describe("foldSeries — powtórzenia w jeden wpis", () => {
  it("zwija rekordy różniące się wyłącznie datą i adresem terminu", () => {
    const r = foldSeries([
      zajecia("2026-08-03", "zajecia-stale-w-odk-bajka"),
      zajecia("2026-08-05", "zajecia-stale-w-odk-bajka-2"),
      zajecia("2026-08-06", "zajecia-stale-w-odk-bajka-3"),
    ]);

    assert.equal(r.events.length, 1);
    assert.deepEqual(r.events[0]?.dates, ["2026-08-03", "2026-08-05", "2026-08-06"]);
    assert.equal(r.events[0]?.date_start, "2026-08-03", "pierwszy termin zostaje datą startu");
    assert.equal(r.events[0]?.date_end, null, "seria NIE jest zakresem — ostatni termin stoi w dates");
    assert.equal(lastDay(r.events[0]), "2026-08-06", "ostatni dzień liczy lastDay, nie date_end");
    assert.equal(r.dropped.length, 2);
    assert.equal(r.dropped[0]?.winner, r.events[0], "wchłonięty wskazuje na wpis serii");
  });

  it("zwiniętej serii nie zwija po raz drugi", () => {
    // `dates` to znacznik „już seria". Dotąd tę rolę pełniło `date_end`, czyli pole danych,
    // i właśnie stąd brał się jeden duplikat na przebieg.
    const once = foldSeries([zajecia("2026-08-03", "a"), zajecia("2026-08-05", "b")]);
    const twice = foldSeries(once.events);

    assert.equal(twice.events.length, 1);
    assert.equal(twice.dropped.length, 0, "nie ma czego zwijać po raz drugi");
    assert.deepEqual(twice.events[0]?.dates, ["2026-08-03", "2026-08-05"]);
  });

  it("różnica W TREŚCI, nie w terminie, zostaje osobnym wydarzeniem", () => {
    // repertuar kina: ten sam cykl, ale każdy seans to inny film
    const seans = (date: string, film: string) => event({
      title: `Kino letnie w Wirach - seans: ${film}`,
      date_start: date, time_start: "21:00", source_id: "komorniki-gok",
    });
    const r = foldSeries([seans("2026-08-05", "Dora"), seans("2026-08-07", "Nomadland")]);

    assert.equal(r.events.length, 2);
    assert.equal(r.dropped.length, 0);
  });

  it("wydarzenie wielodniowe nie wchodzi do serii", () => {
    // date_end znaczy tu „trwa bez przerwy", a nie „powtarza się"
    const festiwal = (start: string, end: string) =>
      event({ title: "Festiwal", date_start: start, date_end: end });
    const r = foldSeries([festiwal("2026-08-01", "2026-08-03"), festiwal("2026-08-10", "2026-08-12")]);

    assert.equal(r.events.length, 2);
    assert.equal(r.events[0]?.dates, undefined);
  });

  it("nie skleja serii między źródłami — od tego jest dedupe", () => {
    const r = foldSeries([
      event({ title: "Joga w parku", date_start: "2026-08-05", source_id: "gok" }),
      event({ title: "Joga w parku", date_start: "2026-08-12", source_id: "osir" }),
    ]);

    assert.equal(r.events.length, 2);
  });

  it("zostawia ślad przy źródle, które dało serię", () => {
    foldSeries([zajecia("2026-08-03", "a"), zajecia("2026-08-05", "b")]);

    const step = auditTrails().find((t) => t.id === "dk-pod-lipami")?.steps[0];
    assert.equal(step?.step, "series");
    assert.match(step?.note ?? "", /zwinięte w jedną serię/);
    assert.equal(step?.detail?.["occurrences"], 2);
  });

  it("nie zaśmieca śladu, gdy nie było czego zwijać", () => {
    foldSeries([event({ title: "Koncert" })]);
    assert.deepEqual(auditTrails(), []);
  });

  it("rozwinięcie i zwinięcie wracają do jednego wpisu z pełną listą terminów", () => {
    const src = event({ repeat: "sb,nd", date_start: TODAY, date_end: "2026-08-09" });
    const r = foldSeries(expandRepeat([src], TODAY));

    assert.equal(r.events.length, 1);
    assert.deepEqual(r.events[0]?.dates,
      ["2026-08-01", "2026-08-02", "2026-08-08", "2026-08-09"]);
  });
});

/**
 * Regresja na „Joga na trawie" (gosir-dopiewo, 2026-08): z jednego wydarzenia zrobiły się
 * cztery, po jednym duplikacie na przebieg. Składały się na to trzy rzeczy i test pilnuje
 * wszystkich, bo każda z osobna wystarczy, żeby wróciło: cache trzymał rekordy ROZWINIĘTE
 * (wartość zależna od „dziś" pod kluczem z samej treści), potok MUTOWAŁ obiekty cache'a,
 * a `date_end` w roli znacznika „już zwinięte" czyniło każdą taką mutację nieodwracalną.
 */
describe("odtworzenie z cache'a nie mnoży wydarzeń", () => {
  /** Dokładnie to, co powiedział model — bez rozwinięcia, tak jak leży teraz w cache'u. */
  const surowy = () => event({
    title: "Joga na trawie", repeat: "nd", date_start: "2026-08-09", date_end: "2026-08-30",
    time_start: "11:00", venue: "Owocowa Plaża w Zborowie", town: "Zborów",
    source_id: "gosir-dopiewo-kalendarz",
  });

  /** Jeden przebieg nad NIEZMIENIONYM cache'em: odczep kopię, rozwiń, zwiń. */
  const przebieg = (cache: EventItem[], today: string): EventItem[] =>
    foldSeries(expandRepeat(detach(cache), today)).events;

  it("cztery przebiegi nad tym samym cache'em dają jedno wydarzenie, nie cztery", () => {
    const cache = [surowy()];
    for (const today of ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]) {
      const out = przebieg(cache, today);
      assert.equal(out.length, 1, `przebieg ${today} zwrócił ${out.length} rekordów`);
    }
  });

  it("przebieg nie zostawia śladu w cache'u — ani rozwinięcia, ani zwinięcia", () => {
    const cache = [surowy()];
    przebieg(cache, "2026-08-10");

    assert.deepEqual(cache, [surowy()], "cache po przebiegu jest bajt w bajt tym, co był");
  });

  it("terminy liczą się od DZIŚ, więc każdy przebieg widzi inną serię — i to jest poprawne", () => {
    const cache = [surowy()];
    assert.deepEqual(przebieg(cache, "2026-08-10")[0]?.dates,
      ["2026-08-16", "2026-08-23", "2026-08-30"]);
    assert.deepEqual(przebieg(cache, "2026-08-20")[0]?.dates,
      ["2026-08-23", "2026-08-30"]);
    // ostatni termin: rytmu nie da się już rozwinąć, zostaje wpis jednodniowy
    const koniec = przebieg(cache, "2026-08-28");
    assert.equal(koniec[0]?.date_start, "2026-08-30");
    assert.equal(koniec[0]?.dates, undefined);
    assert.equal(koniec[0]?.date_end, null);
  });
});

describe("occursIn — które terminy widać w oknie", () => {
  it("seria pokazuje tylko terminy z okna", () => {
    const seria = event({ dates: ["2026-08-05", "2026-08-12", "2026-08-19"] });
    assert.deepEqual(occursIn(seria, "2026-08-10", "2026-08-16"), ["2026-08-12"]);
    assert.deepEqual(occursIn(seria, "2026-08-06", "2026-08-11"), [], "środa poza oknem");
  });

  it("wydarzenie wielodniowe łapie się raz, nie raz na dzień trwania", () => {
    const festiwal = event({ date_start: "2026-07-20", date_end: "2026-08-05" });
    assert.deepEqual(occursIn(festiwal, "2026-08-01", "2026-08-02"), ["2026-08-01"]);
  });
});

describe("seriesLabel — co użytkownik czyta zamiast dwudziestu wierszy", () => {
  const label = (ds: string[]): string =>
    seriesLabel(event({ dates: ds, date_start: ds[0]!, date_end: ds[ds.length - 1]! }));

  it("jeden dzień tygodnia → „w każdą…", () => {
    assert.equal(label(["2026-08-05", "2026-08-12", "2026-08-19"]), "w każdą środę do 19.08");
    assert.equal(label(["2026-08-11", "2026-08-18", "2026-08-25"]), "w każdy wtorek do 25.08");
  });

  it("weekend → liczba mnoga ze spójnikiem", () => {
    assert.equal(
      label(["2026-08-01", "2026-08-02", "2026-08-08", "2026-08-09"]),
      "soboty i niedziele do 9.08",
    );
  });

  it("ciąg dni → codziennie", () => {
    assert.equal(label(["2026-08-01", "2026-08-02", "2026-08-03"]), "codziennie do 3.08");
  });

  it("nieregularny rytm wypisuje TERMINY, zamiast obiecywać te, których nie ma", () => {
    // „Kino letnie w Wirach": środy i piątki, ale tylko w tygodniach 1 i 3
    assert.equal(
      label(["2026-08-05", "2026-08-07", "2026-08-19", "2026-08-21"]),
      "terminy: 5.08, 7.08, 19.08, 21.08",
    );
  });

  it("długa lista terminów się urywa, a nie rozlewa na cały wiersz", () => {
    const many = ["2026-08-03", "2026-08-06", "2026-08-11", "2026-08-14", "2026-08-19", "2026-08-24"];
    assert.equal(label(many), "terminy: 3.08, 6.08, 11.08, 14.08, 19.08 …");
  });

  it("wydarzenie jednorazowe nie dostaje etykiety", () => {
    assert.equal(seriesLabel(event({})), "");
    assert.equal(seriesLabel(event({ dates: ["2026-08-05"] })), "");
  });
});
