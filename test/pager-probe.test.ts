/**
 * PAGER BEZ ADRESÓW: zgadywanie nazwy parametru z DARMOWĄ wyrocznią.
 *
 * `nextPageUrl` czyta adres strony 2 z pagera i to jest droga podstawowa. Zostaje przypadek,
 * w którym czytać nie ma czego: okpoznan.pl wypisuje `<a class="js_ajax_box_page_link">2</a>`
 * bez `href`, bo numer dokłada JS w wywołaniu AJAX.
 *
 * Zgadywanie nazwy parametru samo w sobie odrzuciliśmy przy `nextPageUrl` — i słusznie, bo
 * było NIESPRAWDZALNE. Tutaj sprawdzalne jest za darmo: pomiar 2026-08-21 na okpoznan.pl
 * pokazał, że zła nazwa oddaje po prostu STRONĘ PIERWSZĄ z kodem 200.
 *
 *   ?active_page=2   16 adresów, 16 nowych  → działa
 *   ?page=2 ?pno=2 ?p=2 ?strona=2   16 adresów, ZERO nowych → to nadal strona 1
 *
 * Bez wyroczni płacilibyśmy co dzień za duplikat i widzieli w raporcie sukces. Z wyrocznią
 * kandydaci są tylko generatorem, a rozstrzyga porównanie zbiorów odnośników — pobranie HTTP
 * nic nie kosztuje, więc weryfikacja jest darmowa i pewna, a nie heurystyczna.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isNextPage, listingShape, notePager, pageCandidates, pagerWithoutLinks, rememberedPager }
  from "../src/pipeline/extract/pager-probe.js";
import type { PipelineState } from "../src/types/index.js";

/** okpoznan.pl/wydarzenia, 2026-08-21 — cztery numery, ani jednego `href` */
const OKPOZNAN = `<div class="paggination_box"><div class="numbers"><ul>
  <li class="active"><a class="js_ajax_box_page_link">1</a></li>
  <li><a class="js_ajax_box_page_link">2</a></li>
  <li><a class="js_ajax_box_page_link">3</a></li>
  <li><a class="js_ajax_box_page_link">4</a></li>
</ul></div><div class="btn_sites next"><a class="js_ajax_box_page_next_link">Następna strona</a></div></div>`;

/** mosina.pl/wydarzenia, 2026-08-20 — pager z adresami, czyli NIE dla tej ścieżki */
const MOSINA = `<ul class="pagination">
  <li class="page-item active"><span class="page-link">1</span></li>
  <li class="page-item"><a class="page-link" href="https://www.mosina.pl/wydarzenia?page=2">2</a></li>
  <li class="page-item"><a class="page-link" href="https://www.mosina.pl/wydarzenia?page=3">3</a></li>
</ul>`;

/** Prawdziwe adresy wpisów okpoznan.pl (2026-08-21), przycięte do samych odnośników. */
const strona = (slugi: string[]): string =>
  `<main><div class="element_list"><ul>${slugi
    .map((s) => `<li><a href="/szczegoly-wydarzenia/${s}"><article>Wydarzenie ${s.slice(0, 8)}</article></a></li>`)
    .join("")}</ul></div></main>`;

const S1 = strona([
  "c0ucEPTTWzwrMWBCZpHQ_seniorzy-w-akcji-twoj-wiek-jest-twoim-atutem",
  "rDqjsJYb3bjoOujIVZ6f_rodzinna-wystawa-sensoryczna-mela-i-szczun",
  "XzV0cpN575A2D9XgU396_wolsztyn-historia-napedzana-para",
  "dkvc0MZjtHjgoN2l3qyO_plenerowe-palacowe-2026",
]);
const S2 = strona([
  "Hq9Ror8JanFIUEj0tbWt_ewolucja-szklanych-koralikow-i-bizuterii-na-ukrainie",
  "97ai9ADUSs9SW7GdG4sf_10-lato-z-estrada-chartowo-warsztaty-plastyczne",
  "R9k87ET3OKA3jMdfzGbn_diy-kwiatki-na-szydelku",
  "PWNeLOqZ2Kce9AvIJNw5_10-lato-z-estrada-chartowo-sitko-stoisko-do-odbijania",
]);

const URL1 = "https://okpoznan.pl/wydarzenia";

describe("pager bez adresów", () => {
  it("rozpoznaje pager, którego numery nic nie niosą", () => {
    assert.equal(pagerWithoutLinks(OKPOZNAN), true);
  });

  it("pager Z adresami nie idzie tą ścieżką — od tego jest nextPageUrl", () => {
    assert.equal(pagerWithoutLinks(MOSINA), false);
  });

  it("strona bez pagera to nie jest przypadek do zgadywania", () => {
    assert.equal(pagerWithoutLinks("<main><h1>Wydarzenia</h1><p>Nic.</p></main>"), false);
  });

  it("kandydaci to ADRESY, gotowe do pobrania, i jest ich garść, nie setka", () => {
    const k = pageCandidates(URL1, 2);
    assert.ok(k.length >= 4 && k.length <= 10, `kandydatów: ${k.length}`);
    assert.ok(k.includes("https://okpoznan.pl/wydarzenia?active_page=2"), k.join(" "));
    assert.ok(k.includes("https://okpoznan.pl/wydarzenia?page=2"), k.join(" "));
    // bez duplikatów — każdy kandydat to jedno pobranie
    assert.equal(new Set(k).size, k.length);
  });

  it("kandydat zachowuje parametry, które strona już niosła", () => {
    const k = pageCandidates("https://okpoznan.pl/wydarzenia?by=month", 2);
    assert.ok(k.every((u) => u.includes("by=month")), k.join(" "));
  });
});

describe("wyrocznia: czy to naprawdę druga strona", () => {
  it("inny komplet wpisów = druga strona", () => {
    const v = isNextPage(S1, S2, URL1);
    assert.equal(v.ok, true, v.why);
    assert.match(v.why, /4/u, `notka nie niesie liczby: „${v.why}"`);
  });

  it("ta sama treść = zła nazwa parametru, nie strona 2", () => {
    const v = isNextPage(S1, S1, URL1);
    assert.equal(v.ok, false);
    assert.match(v.why, /ta sama|te same/u, `notka nie tłumaczy odrzucenia: „${v.why}"`);
  });

  it("strona bez wpisów nie jest drugą stroną", () => {
    const v = isNextPage(S1, "<main><p>Brak wyników.</p></main>", URL1);
    assert.equal(v.ok, false);
  });

  /**
   * Jeden wspólny wpis to za mało, żeby uznać stronę za tę samą: listingi bywają posortowane
   * tak, że wpis z pogranicza wraca na obu stronach. Rozstrzyga PRZEWAGA nowych.
   */
  it("jeden wspólny wpis nie unieważnia strony 2", () => {
    const mieszana = strona([
      "dkvc0MZjtHjgoN2l3qyO_plenerowe-palacowe-2026",
      "Hq9Ror8JanFIUEj0tbWt_ewolucja-szklanych-koralikow-i-bizuterii-na-ukrainie",
      "R9k87ET3OKA3jMdfzGbn_diy-kwiatki-na-szydelku",
      "PWNeLOqZ2Kce9AvIJNw5_10-lato-z-estrada-chartowo-sitko-stoisko-do-odbijania",
    ]);
    assert.equal(isNextPage(S1, mieszana, URL1).ok, true);
  });
});

/**
 * PAMIĘĆ WERDYKTU. Sonda kosztuje pobrania u cudzego serwisu — sześć kandydatów przy każdym
 * przebiegu byłoby zachowaniem, którego sami nie chcielibyśmy u siebie. Zapamiętujemy więc
 * także werdykt ODMOWNY, bo to on wraca najczęściej.
 *
 * Wygasanie liczymy przy ODCZYCIE, nie zapisujemy daty końcowej — tak samo jak `sameAsPage`
 * w followup-queue.ts: zmiana progu ma działać od razu, a nie od następnego potwierdzenia.
 */
/**
 * OGON PAGINACJI. okpoznan.pl?active_page=5 oddaje 31 524 znaki strony bez ani jednego wpisu —
 * ramka serwisu i nic więcej. Sonda dat mówi wtedy „w treści nie ma dat, czytaj" (fail open,
 * i słusznie), więc bez drugiej bramki płacilibyśmy za ramkę. Kształt listy ze strony 1
 * rozstrzyga to za darmo: nie ma wpisów, nie ma czego czytać.
 */
describe("kształt listy jako bramka ogona", () => {
  it("strona 1 oddaje szablon wpisu, po którym poznajemy listę", () => {
    const wzor = listingShape(S1, URL1);
    assert.notEqual(wzor, null, "nie rozpoznano listy wpisów na stronie 1");
    // ten sam kształt na stronie 2 — na tym stoi wyrocznia: porównuje wpisy TEGO kształtu,
    // więc gdyby strony miały różne szablony, porównywałaby dwie różne rzeczy
    assert.equal(listingShape(S2, URL1), wzor);
  });

  it("strona bez listy nie ma szablonu — wtedy bramka milczy, zamiast zgadywać", () => {
    assert.equal(listingShape("<main><h1>Kontakt</h1><p>ul. Ratajczaka 44</p></main>",
      "https://okpoznan.pl/kontakt"), null);
  });
});

describe("pamięć sondy", () => {
  const stan = (): PipelineState => ({ hashes: {}, geo: {} });

  it("świeży werdykt oszczędza sondę", () => {
    const s = stan();
    notePager(s, "okpoznan", "https://okpoznan.pl/wydarzenia?active_page={page}", "2026-08-21");
    const v = rememberedPager(s, "okpoznan", "2026-08-24", 14);
    assert.equal(v?.url, "https://okpoznan.pl/wydarzenia?active_page={page}");
  });

  it("ODMOWA też jest pamiętana — inaczej sonda wraca codziennie", () => {
    const s = stan();
    notePager(s, "gok", null, "2026-08-21");
    const v = rememberedPager(s, "gok", "2026-08-22", 14);
    assert.equal(v?.url, null, "odmowa nie została zapamiętana");
  });

  it("po progu werdykt wygasa — serwis mógł się przebudować", () => {
    const s = stan();
    notePager(s, "gok", null, "2026-08-21");
    assert.equal(rememberedPager(s, "gok", "2026-09-05", 14), undefined);
  });

  it("źródło nigdy nie sondowane nie ma werdyktu", () => {
    assert.equal(rememberedPager(stan(), "nowe", "2026-08-21", 14), undefined);
  });
});
