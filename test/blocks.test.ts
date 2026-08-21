/**
 * Testujemy jedną własność, na której stoi cały pomysł: usunięcie karty z listy ma
 * unieważnić TYLKO blok z tą kartą. Gdyby granice liczyły się od pozycji, a nie od treści,
 * wypadnięcie wczorajszego wydarzenia przesunęłoby wszystkie kolejne i cache dawałby zero
 * trafień akurat w najczęstszym przypadku — a raport z pomiaru pokazywałby wtedy, że
 * „bloki nie pomagają", zamiast że pomylono się w segmentacji.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ceilingReuse, paragraphs, reuseAgainst, segment } from "../src/pipeline/extract/blocks.js";

/**
 * Strona-lista: nagłówek + N kart wydarzeń o tym samym kształcie.
 *
 * Karta zależy WYŁĄCZNIE od tytułu — również data, choć naturalniej byłoby ją numerować
 * pozycją na liście. Przy numerowaniu pozycją usunięcie jednej karty przepisuje daty
 * wszystkich następnych, więc test mierzyłby wtedy własną atrapę zamiast segmentacji
 * (i pokazywał 4 nowe bloki tam, gdzie zmieniła się jedna karta).
 */
const page = (titles: string[]): string =>
  ["ESTRADA POZNAŃSKA\n\nDZIEJE SIĘ!", ...titles.map((t) =>
    `Okładka wydarzenia - ${t}\n\n${t.toUpperCase()}\n\n${String(t.length).padStart(2, "0")} / 08 / 26 19:00\n\n` +
    `Opis wydarzenia ${t}, w którym stoi tyle tekstu, ile zwykle stoi w zajawce karty.\n\n` +
    `[https://www.estrada.poznan.pl/event/${t.toLowerCase()}/]`)].join("\n\n");

/**
 * Dwadzieścia kart, bo tyle mniej więcej wypisuje prawdziwa lista (estrada.poznan.pl miała
 * przy audycie wejścia 24 odnośniki do podstron). Na ośmiu kartach jeden unieważniony blok
 * to jeszcze ~30% strony i próg odzysku mierzyłby rozmiar atrapy, a nie segmentację.
 */
const TITLES = [
  "Peregrinus", "Robotarobota", "Kwadrofonik", "Lautari", "Bastarda", "Hania", "Kroke", "Vlodi",
  "Meritum", "Nokturn", "Pogodno", "Rebeka", "Sutari", "Tulia", "Waglewski", "Ziyo",
  "Antonia", "Bemibem", "Cisza", "Dagadana",
];

describe("podział na bloki", () => {
  it("tnie na szwach akapitów, nigdy w połowie wiersza", () => {
    const blocks = segment(page(TITLES));
    assert.ok(blocks.length > 1, "strona z ośmioma kartami ma dać więcej niż jeden blok");
    for (const b of blocks) assert.equal(b.text, b.text.trim());
    // suma bloków to wszystkie akapity strony, bez gubienia i bez powtórek
    assert.deepEqual(
      blocks.flatMap((b) => paragraphs(b.text)),
      paragraphs(page(TITLES)),
    );
  });

  it("usunięcie karty unieważnia tylko jej blok", () => {
    const before = segment(page(TITLES));
    const after = segment(page(TITLES.filter((t) => t !== "Kwadrofonik")));

    const seen = new Set(before.map((b) => b.hash));
    const stat = reuseAgainst(after, seen);
    assert.ok(stat.newBlocks <= 1, `spodziewane ≤1 nowego bloku, było ${stat.newBlocks}`);
    assert.ok(stat.reuse > 0.7, `spodziewane >70% odzysku, było ${(stat.reuse * 100).toFixed(1)}%`);
  });

  it("dzień bez zmian nie daje ani jednego nowego bloku", () => {
    const seen = new Set(segment(page(TITLES)).map((b) => b.hash));
    assert.equal(reuseAgainst(segment(page(TITLES)), seen).newBlocks, 0);
  });

  it("dopisanie karty kosztuje mniej więcej tę kartę", () => {
    const seen = new Set(segment(page(TITLES)).map((b) => b.hash));
    const stat = reuseAgainst(segment(page([...TITLES, "Mitch"])), seen);
    assert.ok(stat.newBlocks >= 1, "nowa treść musi trafić do modelu");
    assert.ok(stat.reuse > 0.7, `spodziewane >70% odzysku, było ${(stat.reuse * 100).toFixed(1)}%`);
  });
});

/**
 * Powód cięcia jest OBSERVABILITY, więc jego złamanie jest ciche — podgląd podziału
 * pokazywałby po prostu inne etykiety i nikt by nie zauważył. Stąd asercje na konkretny
 * powód przy konkretnym kształcie wejścia, nie na obecność pola.
 */
describe("czemu granica wypadła tutaj", () => {
  it("granica z treści to `content`, ostatni blok strony to `end`", () => {
    const blocks = segment(page(TITLES));
    assert.ok(blocks.length > 2, "za mało bloków, żeby rozróżnić powody");
    assert.equal(blocks[blocks.length - 1]?.cut, "end");
    // wszystko przed ostatnim zamknęła treść akapitu — sufit 4000 zn. nie ma tu czego łapać
    for (const b of blocks.slice(0, -1)) assert.equal(b.cut, "content");
  });

  /**
   * Sufit jest jedyną granicą zależną od POZYCJI, więc to on psuje lokalność cache'a —
   * a bez etykiety w archiwum nie da się powiedzieć, czy strona tnie się treścią, czy
   * przelewa przez sufit. Wymuszamy go progiem, bo na żywej stronie odzywa się rzadko.
   */
  it("cięcie samym sufitem to `ceiling`", () => {
    const blocks = segment(page(TITLES), { maxChars: 300, targetParas: 1000 });
    assert.ok(blocks.some((b) => b.cut === "ceiling"), "sufit nie odnotował ani jednego cięcia");
    assert.ok(!blocks.some((b) => b.cut === "content"), "przy targetParas 1000 nie ma granic z treści");
  });
});

/**
 * GRANICA NA ZMIANIE RODZAJU AKAPITU.
 *
 * Dotąd granice stawiał wyłącznie hash akapitu, czyli średnio co szósty — więc stopka obok
 * ogona karty zostawała z nim w jednym bloku, jeśli moneta nie padła akurat między nimi.
 * Blok mieszany jest nie do odsiania z definicji: zabrałby ze sobą wydarzenie. Pomiar
 * z 2026-08-20 na 53 stronach: 31 814 znaków chromu tkwiło w blokach niejednorodnych,
 * po tej zmianie 11 270.
 */
describe("granica na zmianie rodzaju akapitu", () => {
  /** ok-lubon.pl, 2026-08-20 — ogon karty, pasek stron i stopka prawna w jednym bloku. */
  const SKLEJKA = [
    "14 marca 2026 12:00 - 13:00\n[https://www.oklubon.pl/wydarzenia/spektakl-dla-dzieci-jajko]",
    "POLITYKA PRYWATNOŚCI",
    "Ta strona korzysta z plików cookies aby świadczyć usługi na najwyższym poziomie."
      + " Dalsze korzystanie ze strony oznacza zgodę, zgodnie z polityką prywatności.",
  ].join("\n\n");

  it("data i stopka prawna nie mogą wylądować w jednym bloku", () => {
    const blocks = segment(SKLEJKA);
    const zData = blocks.filter((b) => b.text.includes("14 marca 2026"));
    assert.equal(zData.length, 1, "akapit z datą ma stać w dokładnie jednym bloku");
    assert.ok(
      !zData[0]!.text.includes("POLITYKA PRYWATNOŚCI"),
      "blok z datą wciąż niesie stopkę — odsiew nie ma jak jej ruszyć",
    );
  });

  it("powód cięcia mówi wprost, że to zmiana rodzaju", () => {
    const cuts = segment(SKLEJKA).map((b) => b.cut);
    assert.ok(cuts.includes("flip"), `brak granicy \`flip\` w śladzie: ${cuts.join(", ")}`);
  });

  /**
   * Własność, dla której ten podział w ogóle istnieje, MUSI przeżyć nową granicę: rodzaj
   * akapitu zależy wyłącznie od jego własnej treści, więc usunięcie karty nadal przesuwa
   * granice tylko w jej sąsiedztwie. Sprawdzone też na żywej stronie (okpoznan, 43 bloki):
   * jeden nowy blok po zniknięciu trzech akapitów.
   */
  it("nie psuje lokalności: usunięcie karty to nadal jeden nowy blok", () => {
    const chrom = "\n\nMenu [/]\n\nPolityka prywatności [/polityka]\n\nMapa strony [/mapa]";
    const before = segment(page(TITLES) + chrom);
    const after = segment(page(TITLES.filter((t) => t !== "Kwadrofonik")) + chrom);
    const seen = new Set(before.map((b) => b.hash));
    assert.ok(
      after.filter((b) => !seen.has(b.hash)).length <= 1,
      `spodziewany ≤1 nowy blok, było ${after.filter((b) => !seen.has(b.hash)).length}`,
    );
  });
});

describe("sufit odzysku", () => {
  it("identyczna treść to 100%, rozłączna to 0%", () => {
    assert.equal(ceilingReuse(page(TITLES), page(TITLES)), 1);
    assert.equal(ceilingReuse("alfa\nbeta", "gamma\ndelta"), 0);
  });

  it("jest górnym ograniczeniem dla podziału na bloki", () => {
    const prev = page(TITLES);
    const next = page([...TITLES.filter((t) => t !== "Lautari"), "Mitch"]);
    const stat = reuseAgainst(segment(next), new Set(segment(prev).map((b) => b.hash)));
    assert.ok(
      stat.reuse <= ceilingReuse(prev, next) + 1e-9,
      `bloki (${stat.reuse}) nie mogą odzyskać więcej niż sufit (${ceilingReuse(prev, next)})`,
    );
  });
});

/**
 * ODNOŚNIK NALEŻY DO KARTY NAD SOBĄ.
 *
 * Gdy `<a>` owija całą kartę (`<a><article>…</article></a>`), renderer wypuszcza adres
 * dopiero ZA jej tekstem, osobnym akapitem. Granica z hasha nie wie, że te dwa akapity to
 * jedna rzecz, więc potrafi wypaść dokładnie między nimi — zostaje blok z samym adresem
 * i karta, która nie ma jak swojego adresu podać.
 *
 * Tekst niżej to prawdziwy render karty z okpoznan.pl/wydarzenia (2026-08-21) — ta sama,
 * przez którą „Wolsztyn. Historia napędzana parą" poszedł w digeście z adresem listingu.
 */
describe("akapit będący samym odnośnikiem", () => {
  const bareLink = (text: string): boolean => /^\[[^\]\s]+\]$/.test(text.trim());

  /** render karty Wolsztyna z okpoznan.pl/wydarzenia, pobrany 2026-08-21 */
  const KARTA = [
    " * Sie\n   03\n   -\n   Wrz\n   30\n   #1\n   60+",
    "WOLSZTYN. HISTORIA NAPĘDZANA PARĄ",
    "03.08 - 30.09.2026",
    "ul. Franciszka Ratajczaka 44, Poznań",
    "[/szczegoly-wydarzenia/XzV0cpN575A2D9XgU396_wolsztyn-historia-napedzana-para]",
  ].join("\n\n");

  it("zostaje w bloku karty, a nie startuje własnego", () => {
    const blocks = segment(KARTA);
    assert.deepEqual(
      blocks.filter((b) => bareLink(b.text)).map((b) => b.text), [],
      "adres oderwał się od karty — model dostaje kartę bez adresu i blok bez treści",
    );
    assert.ok(
      blocks.some((b) => b.text.includes("WOLSZTYN") && b.text.includes("wolsztyn-historia")),
      "tytuł i adres tej samej karty mają wyjść jednym blokiem",
    );
  });

  it("adres nie znika — przesuwamy granicę, nie odsiewamy treści", () => {
    const all = segment(KARTA).map((b) => b.text).join("\n");
    assert.ok(all.includes("wolsztyn-historia-napedzana-para"));
  });

  // --- regresja: czego ta reguła NIE ma prawa ruszyć ---

  it("akapit z tekstem I adresem zostaje zwykłym akapitem", () => {
    // „Szczegóły [/event/x]" niesie własne słowo, więc nigdy nie był sierotą i granica
    // przed nim jest tak samo dobra, jak każda inna — inaczej reguła zaczęłaby sklejać karty
    const text = ["KONCERT W PARKU", "12 / 08 / 26 19:00", "Szczegóły [/event/koncert]"].join("\n\n");
    assert.equal(segment(text).filter((b) => bareLink(b.text)).length, 0);
    assert.deepEqual(segment(text), segment(text), "podział ma być deterministyczny");
  });

  it("sam odnośnik na POCZĄTKU tekstu nie ma się do czego dokleić i zostaje", () => {
    const text = ["[/szczegoly-wydarzenia/abc_pierwsza]", "PIERWSZA KARTA", "01.09.2026"].join("\n\n");
    const all = segment(text).map((b) => b.text).join("\n");
    assert.ok(all.includes("abc_pierwsza"), "adres bez poprzednika zniknął zamiast zostać");
  });
});
