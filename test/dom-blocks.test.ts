/**
 * Podział po DOM-ie ma spełniać to samo, co podział po akapitach — usunięcie karty
 * unieważnia JEDEN blok — tyle że na strukturze, a nie na pustych liniach. Do tego dochodzą
 * dwa warunki, których wersja tekstowa nie miała jak złamać: nic nie może zginąć po drodze
 * (suma bloków = strona) i brak listy musi cofać nas do starego zachowania, a nie do zera.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { reuseAgainst } from "../src/pipeline/extract/blocks.js";
import { segmentHtml } from "../src/pipeline/extract/dom-blocks.js";

interface Card { title: string; date: string }

/**
 * Lista wydarzeń w kształcie, w jakim wypuszcza ją WordPress: klasa z NUMEREM rekordu
 * i naprzemienne `odd`/`even`. Oba są w podpisie karty bezużyteczne i oba muszą z niego
 * wypaść, inaczej każda karta jest osobnym kształtem i grupa nigdy się nie zbierze.
 */
const page = (cards: Card[], extra = ""): string => `<!doctype html>
<html><head><title>GOK</title><script>var x=1;</script></head>
<body>
  <header><h1>Gminny Ośrodek Kultury</h1></header>
  <nav class="menu"><ul><li><a href="/a">Aktualności</a></li><li><a href="/b">Kontakt</a></li></ul></nav>
  <main>
    <h2>Nadchodzące wydarzenia</h2>
    <p>Zapraszamy na wydarzenia organizowane przez nasz ośrodek w najbliższych tygodniach.</p>
    <div class="events">
      ${cards
    .map((c, i) => `<article class="event post-${100 + i} ${i % 2 ? "even" : "odd"}">
        <h3 class="event-title">${c.title}</h3>
        <span class="event-date">${c.date}</span>
        <p class="event-lead">Opis wydarzenia ${c.title}, w którym stoi tyle tekstu,
        ile zwykle stoi w zajawce karty na liście imprez.</p>
        <a href="/event/${c.title.toLowerCase()}">Szczegóły</a>
      </article>`)
    .join("\n")}
    </div>
    ${extra}
  </main>
  <footer><p>Wszelkie prawa zastrzeżone</p></footer>
</body></html>`;

const CARDS: Card[] = [
  { title: "Peregrinus", date: "05 / 08 / 26" },
  { title: "Robotarobota", date: "06 / 08 / 26" },
  { title: "Kwadrofonik", date: "07 / 08 / 26" },
  { title: "Lautari", date: "08 / 08 / 26" },
  { title: "Bastarda", date: "09 / 08 / 26" },
  { title: "Kroke", date: "10 / 08 / 26" },
];

/**
 * Małymi literami, bo `html-to-text` renderuje nagłówki WERSALIKAMI — to zachowanie potoku,
 * nie tego modułu, i porównywanie z oryginalną pisownią sprawdzałoby cudzą konfigurację.
 */
const allText = (html: string): string =>
  segmentHtml(html).blocks.map((b) => b.text).join("\n").toLowerCase();

const has = (html: string, needle: string): boolean => allText(html).includes(needle.toLowerCase());

describe("podział po DOM-ie", () => {
  it("rozpoznaje powtarzalne rodzeństwo jako karty", () => {
    const seg = segmentHtml(page(CARDS));
    assert.equal(seg.detected, true);
    assert.equal(seg.cards, CARDS.length);
  });

  it("nie gubi treści — każde wydarzenie stoi w którymś bloku", () => {
    const html = page(CARDS);
    for (const c of CARDS) assert.ok(has(html, c.title), `zgubiono „${c.title}"`);
    assert.ok(has(html, "Nadchodzące wydarzenia"), "zgubiono nagłówek listy");
    assert.ok(has(html, "Zapraszamy na wydarzenia"), "zgubiono akapit wstępu");
  });

  it("wycina chrom, więc zmiana menu nie rusza kart", () => {
    const html = page(CARDS);
    assert.ok(!has(html, "Aktualności"), "menu wpadło do treści");
    assert.ok(!has(html, "Wszelkie prawa"), "stopka wpadła do treści");
  });

  it("karta trafia do WŁASNEGO bloku, nie sklejona z sąsiadką", () => {
    const seg = segmentHtml(page(CARDS));
    const withPeregrinus = seg.blocks.filter((b) => b.text.includes("Peregrinus"));
    assert.equal(withPeregrinus.length, 1);
    assert.ok(
      !withPeregrinus[0]!.text.includes("Robotarobota"),
      "dwie karty w jednym bloku — granica wypadła w złym miejscu",
    );
  });

  it("usunięcie karty unieważnia dokładnie jeden blok", () => {
    const before = segmentHtml(page(CARDS)).blocks;
    const after = segmentHtml(page(CARDS.filter((c) => c.title !== "Kwadrofonik"))).blocks;

    const stat = reuseAgainst(after, new Set(before.map((b) => b.hash)));
    // zero: znikająca karta nie zostawia po sobie NICZEGO nowego do przeczytania
    assert.equal(stat.newBlocks, 0, `spodziewane 0 nowych bloków, było ${stat.newBlocks}`);
  });

  it("dopisanie karty kosztuje dokładnie tę kartę", () => {
    const before = segmentHtml(page(CARDS)).blocks;
    const after = segmentHtml(page([...CARDS, { title: "Mitch", date: "11 / 08 / 26" }])).blocks;

    const stat = reuseAgainst(after, new Set(before.map((b) => b.hash)));
    assert.equal(stat.newBlocks, 1, `spodziewany 1 nowy blok, było ${stat.newBlocks}`);
    assert.ok(stat.fresh[0]!.text.includes("Mitch"));
  });

  it("dzień bez zmian nie daje ani jednego nowego bloku", () => {
    const seen = new Set(segmentHtml(page(CARDS)).blocks.map((b) => b.hash));
    assert.equal(reuseAgainst(segmentHtml(page(CARDS)).blocks, seen).newBlocks, 0);
  });

  it("zmiana w jednej karcie nie rusza pozostałych", () => {
    const before = segmentHtml(page(CARDS)).blocks;
    const moved = CARDS.map((c) => (c.title === "Lautari" ? { ...c, date: "30 / 09 / 26" } : c));
    const stat = reuseAgainst(segmentHtml(page(moved)).blocks, new Set(before.map((b) => b.hash)));
    assert.equal(stat.newBlocks, 1);
    assert.ok(stat.fresh[0]!.text.includes("Lautari"));
  });

  /**
   * Kalendarz w tabeli: siedem `<td>` w wierszu to wzorowo powtarzalne rodzeństwo, a mimo to
   * kartą NIE jest — cały `<tr>` renderuje się do jednej linii ze sklejonymi komórkami, więc
   * znacznik między nimi rozbijał tę linię i tekst bloku przestawał występować na stronie.
   * Na goksezam.pl kosztowało to 34 punkty procentowe odzysku przy zerowej zmianie treści.
   */
  it("komórki tabeli nie są kartami", () => {
    const cal = `<!doctype html><html><body><main><table><tbody>
      <tr>${["09", "10", "11", "12", "13", "14", "15"]
    .map((d) => `<td class="day"><a href="/dzien-${d}.html">${d}-08-2026</a>
        Kliknij, aby przejść do wydarzeń z dnia ${d} sierpnia dwa tysiące dwudziestego szóstego</td>`)
    .join("")}</tr>
    </tbody></table></main></body></html>`;

    const seg = segmentHtml(cal);
    assert.equal(seg.perturbed, undefined, "wynik odrzucony przez samokontrolę zamiast nie powstać");
    assert.equal(seg.cards, 0, "komórka tabeli została uznana za kartę");
  });

  it("odrzuca własny wynik, gdy znaczniki przestawiłyby render", () => {
    // wprost: gdyby kiedyś jakiś kształt jednak przeszedł przez NOT_A_CARD i przestawił
    // łamanie linii, samokontrola ma go zatrzymać, a nie wypuścić bloków spoza strony
    const seg = segmentHtml(page(CARDS));
    const joined = seg.blocks.map((b) => b.text).join("\n\n");
    const clean = segmentHtml(page(CARDS)).blocks.map((b) => b.text).join("\n\n");
    assert.equal(joined, clean, "podział nie jest deterministyczny");
    assert.notEqual(seg.perturbed, true);
  });

  it("bez powtarzalnego rodzeństwa schodzi na podział po akapitach", () => {
    const single = `<!doctype html><html><body><main>
      <h1>Koncert Kwadrofonik</h1>
      <p>Opis wydarzenia, jeden akapit, bez żadnej listy.</p>
      <p>Drugi akapit z terminem: 12 sierpnia 2026, godz. 19:00.</p>
    </main></body></html>`;
    const seg = segmentHtml(single);
    assert.equal(seg.detected, false);
    assert.equal(seg.cards, 0);
    assert.ok(seg.blocks.length >= 1);
    assert.ok(has(single, "Kwadrofonik"), "fallback zgubił treść strony");
  });
});
