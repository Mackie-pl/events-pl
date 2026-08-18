/**
 * Sonda kontenerów: wpis o kształcie strony programu.
 *
 * Wszystkie wartości pochodzą z `events.json` z 2026-08-18 (234 wydarzenia) — z tego samego
 * pomiaru, który wyznaczył próg 8 dni. Zakresów dłuższych niż tydzień bez rytmu było tam 18,
 * a żaden z nich nie był jednym wydarzeniem: albo program („SIERPIEŃ 2026 W ZAMKU", „Akcja
 * Lato z Biblioteką", „Seniorzy w akcji"), albo wystawa czynna miesiącami. Festiwale i zjazdy
 * mieszczą się w 2–7 dniach i mają tu zostać nietknięte.
 *
 * Przypadek prowadzący: karta „Seniorzy w akcji | Twój wiek jest Twoim atutem"
 * z `okpoznan.pl/wydarzenia` (Lip 27 – Sie 31, 60+), pod której odnośnikiem stoi dziesięć
 * zajęć z godzinami i miejscami.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  containerSpan, dropUmbrellas, isContainerSuspect, planProbes, probeContext,
} from "../src/pipeline/extract/container.js";
import { segmentHtml } from "../src/pipeline/extract/dom-blocks.js";
import type { PipelineState } from "../src/types/index.js";

import { event } from "./helpers.js";

const LISTA = "https://okpoznan.pl/wydarzenia";
const SENIORZY = "https://okpoznan.pl/szczegoly-wydarzenia/"
  + "c0ucEPTTWzwrMWBCZpHQ_seniorzy-w-akcji-twoj-wiek-jest-twoim-atutem";

/** Wpis tak, jak wszedł do events.json 2026-08-18 — bez godziny, bez miejsca, 36 dni. */
const seniorzy = () => event({
  title: "Seniorzy w akcji | Twój wiek jest Twoim atutem",
  date_start: "2026-07-27",
  date_end: "2026-08-31",
  town: "Poznań",
  source_url: SENIORZY,
});

const state = (extractions: NonNullable<PipelineState["extractions"]> = {}): PipelineState =>
  ({ hashes: {}, geo: {}, extractions });

describe("kształt kontenera", () => {
  it("36 dni bez rytmu i bez godziny — to jest ten kształt", () => {
    assert.equal(containerSpan(seniorzy()), 36);
    assert.equal(isContainerSuspect(seniorzy(), 8), true);
  });

  it("rytm zdejmuje podejrzenie: zakres z rytmem ma konkretne terminy, nie trwa bez przerwy", () => {
    // „Kino letnie w Wirach" — ten sam zakres, ale potok umie z niego wyliczyć dni
    const ev = event({ date_start: "2026-07-27", date_end: "2026-08-31", repeat: "sb,nd" });
    assert.equal(containerSpan(ev), null);
  });

  it("godzina startu zdejmuje podejrzenie — ktoś opisywał pojedyncze wystąpienie", () => {
    // „OFERTA INDYWIDUALNA W LABORATORIUM WYOBRAŹNI" (poznan-co-gdzie-kiedy): 22 dni, 10:00.
    // Świadomie przepuszczone — 1 wpis z 18, patrz nagłówek container.ts
    const ev = event({ date_start: "2026-07-30", date_end: "2026-08-20", time_start: "10:00" });
    assert.equal(isContainerSuspect(ev, 8), false);
  });

  it("festiwal weekendowy zostaje: 2–7 dni to jedno wydarzenie, nie program", () => {
    const ev = event({ date_start: "2026-08-14", date_end: "2026-08-16" });
    assert.equal(containerSpan(ev), 3);
    assert.equal(isContainerSuspect(ev, 8), false);
  });

  it("próg 0 wyłącza regułę — parametr ma naprawdę wyłączać, nie tylko zmniejszać", () => {
    assert.equal(isContainerSuspect(seniorzy(), 0), false);
  });
});

describe("planProbes — co idzie do sondy", () => {
  it("bierze adres karty, nie adres listingu", () => {
    const plan = planProbes([seniorzy()], { pageUrl: LISTA, state: state(), taken: [] });

    assert.equal(plan.suspects, 1);
    assert.deepEqual(plan.probes.map((p) => p.url), [SENIORZY]);
    assert.equal(plan.probes[0]?.days, 36);
  });

  it("wpis wskazujący SAMĄ stronę źródła nie ma czego dociągać", () => {
    // „Wolsztyn. Historia napędzana parą" (okpoznan, 59 dni) ma source_url = /wydarzenia
    const ev = event({ date_start: "2026-08-03", date_end: "2026-09-30", source_url: LISTA });
    const plan = planProbes([ev], { pageUrl: LISTA, state: state(), taken: [] });

    assert.equal(plan.suspects, 1, "podejrzany jest — po prostu nie ma go gdzie sprawdzić");
    assert.deepEqual(plan.probes, []);
  });

  it("adres wskazany już przez model nie idzie drugi raz", () => {
    const plan = planProbes([seniorzy()], { pageUrl: LISTA, state: state(), taken: [SENIORZY] });

    assert.deepEqual(plan.probes, []);
  });

  it("poddomena tego samego urzędu przechodzi, obcy serwis nie", () => {
    // bip.lubon.pl przy źródle lubon.pl — ten sam właściciel adresu (stypendia, 32 dni)
    const bip = event({
      date_start: "2026-08-15", date_end: "2026-09-15",
      source_url: "https://bip.lubon.pl/8-program-stypendialny-wspierania-edukacji",
    });
    const obcy = event({
      date_start: "2026-08-15", date_end: "2026-09-15",
      source_url: "https://kinopalacowe.pl/filmy/14738-do-utraty-tchu",
    });
    const plan = planProbes([bip, obcy], {
      pageUrl: "https://lubon.pl/aktualnosci", state: state(), taken: [],
    });

    assert.equal(plan.probes.length, 1);
    assert.match(plan.probes[0]?.url ?? "", /bip\.lubon\.pl/);
  });

  it("adres nigdy niepobrany idzie przed tym, który ma już wpis w cache'u followupów", () => {
    const stary = event({
      date_start: "2026-06-22", date_end: "2026-08-25",
      source_url: "https://okpoznan.pl/szczegoly-wydarzenia/aaa_lato-w-bibliotece",
    });
    const st = state({
      "okpoznan.pl/szczegoly-wydarzenia/aaa_lato-w-bibliotece": {
        hash: "x", events: [], at: "2026-08-17T05:00:00.000Z",
      },
    });
    const plan = planProbes([stary, seniorzy()], { pageUrl: LISTA, state: st, taken: [] });

    assert.equal(plan.probes[0]?.url, SENIORZY, "nowy adres pierwszy");
    assert.equal(plan.probes.length, 2, "stary nie wypada z kolejki — strona może zyskać program");
  });
});

describe("probeContext — zakres z karty, którego na stronie programu nie ma", () => {
  it("niesie tytuł i OBIE granice zakresu", () => {
    const plan = planProbes([seniorzy()], { pageUrl: LISTA, state: state(), taken: [] });
    const ctx = probeContext(plan.probes[0]!);

    assert.match(ctx, /2026-07-27/);
    assert.match(ctx, /2026-08-31/);
    assert.match(ctx, /Seniorzy w akcji/);
  });

  it("wpis jednodniowy nie zmyśla końca zakresu", () => {
    // teoretyczny, ale kształt musi być odporny: `to` schodzi do `from`, a nie do „null"
    const ev = event({ date_start: "2026-08-01", date_end: null, source_url: SENIORZY });
    const plan = planProbes([ev], { pageUrl: LISTA, state: state(), taken: [] });

    assert.deepEqual(plan.probes, [], "bez zakresu nie ma podejrzenia, więc nie ma i kontekstu");
  });
});

describe("dropUmbrellas — parasol znika dopiero, gdy pod nim coś stoi", () => {
  /** Zajęcia tak, jak stoją na stronie programu: własna godzina, wspólny adres. */
  const zajecia = (title: string, time: string) =>
    event({ title, date_start: "2026-08-24", time_start: time, source_url: SENIORZY });

  it("dwa wydarzenia z terminami zastępują parasol", () => {
    const all = [
      seniorzy(),
      zajecia("Nordic walking nad Maltą", "12:00"),
      zajecia("Badminton w Hali Sportowej Wilda", "12:00"),
    ];
    const r = dropUmbrellas(all, [SENIORZY]);

    assert.equal(r.kept.length, 2);
    assert.equal(r.kept.some((e) => e.title.startsWith("Seniorzy w akcji")), false);
    assert.equal(r.dropped[0]?.children, 2);
  });

  it("jedno wydarzenie to za mało — strona opisała samą siebie, a nie program", () => {
    const r = dropUmbrellas([seniorzy(), zajecia("Tai chi", "12:00")], [SENIORZY]);

    assert.equal(r.kept.length, 2);
    assert.deepEqual(r.dropped, []);
  });

  it("obie kopie parasola znikają razem — także ta odczytana ze strony programu", () => {
    // sonda czyta nagłówek strony i oddaje ten sam wpis drugi raz; dedupe scala po tytule
    // i dacie, więc gdyby tytuły się rozjechały, w rejestrze zostałby bezużyteczny bliźniak
    const kopia = event({ ...seniorzy(), title: "Akcja Lato - Seniorzy w Akcji" });
    const all = [
      seniorzy(), kopia,
      zajecia("Nordic walking nad Maltą", "12:00"),
      zajecia("Tai chi na Pływalni Grunwald", "12:00"),
    ];
    const r = dropUmbrellas(all, [SENIORZY]);

    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 2);
  });

  it("nie rusza wpisów spod adresów, których nie sondowaliśmy", () => {
    const inny = event({
      date_start: "2026-07-28", date_end: "2026-10-06",
      title: 'Rodzinna wystawa sensoryczna "Mela i szczun na historycznej ścieżce"',
      source_url: "https://okpoznan.pl/szczegoly-wydarzenia/rDqjsJYb3bjoOujIVZ6f_mela",
    });
    const r = dropUmbrellas([inny], [SENIORZY]);

    assert.deepEqual(r.dropped, []);
    assert.equal(r.kept.length, 1);
  });
});

/**
 * Prawdziwa podstrona programu — `test/fixtures/okpoznan-seniorzy-2026-08-18.html`,
 * pobrana 2026-08-18 z okpoznan.pl (82 553 B, HTTP 200).
 *
 * Ten zestaw NIE sprawdza modelu (na to nie ma darmowej wyroczni), tylko DOWÓD, dla którego
 * sonda musi wieźć ze sobą zakres z karty: program stoi w bloku, który opisuje zajęcia
 * rytmem i nie niesie ani jednej daty. Pierwsza sonda bez kontekstu oddała z tej strony
 * 5 wydarzeń, wszystkie z ramki „INNE WYDARZENIA" — i to było zachowanie POPRAWNE.
 */
describe("prawdziwa strona programu: skąd bierze się pusty wynik bez kontekstu", () => {
  const html = readFileSync(
    fileURLToPath(new URL("fixtures/okpoznan-seniorzy-2026-08-18.html", import.meta.url)), "utf8",
  );
  const blocks = segmentHtml(html).blocks.map((b) => b.text);
  const programBlock = blocks.find((t) => /nordic walking/i.test(t) && /badminton/i.test(t));

  it("program wakacyjny mieści się w jednym bloku, z godzinami i miejscami", () => {
    assert.ok(programBlock, "blok z nordic walkingiem i badmintonem istnieje");
    assert.match(programBlock, /Hali Sportowej Wilda/);
    assert.match(programBlock, /Pływalni Miejskiej Grunwald/);
    assert.match(programBlock, /12:00/);
  });

  it("blok niesie RYTM i początek zakresu, ale NIE niesie jego końca", () => {
    // to jest cała przyczyna: `repeat` wymaga `date_end` (REPEAT_NOTE w event-schema.ts),
    // a końca zakresu na tej stronie nie ma — stoi wyłącznie na karcie listingu („Sie 31")
    assert.match(programBlock ?? "", /poniedziałki/);
    assert.match(programBlock ?? "", /wtorki/);
    assert.match(programBlock ?? "", /środy/);
    assert.match(programBlock ?? "", /Lip\s*\n?\s*27/);
    assert.equal(/sierp|\bsie\b|31\.08/i.test(programBlock ?? ""), false,
      "gdyby koniec zakresu tu był, kontekst z karty nie byłby do niczego potrzebny");
  });

  it("ramka z rekomendacjami to OSOBNE bloki z własnymi adresami", () => {
    const inne = blocks.filter((t) => /szczegoly-wydarzenia\/(?!c0ucEPTTWzwrMWBCZpHQ)/.test(t));
    assert.ok(inne.length >= 4, `rekomendacje stoją osobno (${inne.length} bloków)`);
    assert.equal(inne.some((t) => /nordic walking/i.test(t)), false,
      "program nie wymieszał się z rekomendacjami");
  });
});
