/**
 * Podział po DOM-ie ma spełniać to samo, co podział po akapitach — usunięcie karty
 * unieważnia JEDEN blok — tyle że na strukturze, a nie na pustych liniach. Do tego dochodzą
 * dwa warunki, których wersja tekstowa nie miała jak złamać: nic nie może zginąć po drodze
 * (suma bloków = strona) i brak listy musi cofać nas do starego zachowania, a nie do zera.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

/**
 * MENU TO NIE KARTA, choćby miało kształt karty.
 *
 * Wykrywanie kart pyta wyłącznie o STRUKTURĘ: powtarzalne rodzeństwo o tym samym podpisie.
 * Drzewo nawigacji z `<li>` spełnia to co do joty, więc mdk1/mdk2.poznan.pl oddawały spis
 * oferty zajęć (3 504 i 3 201 zn.) jako kartę wydarzenia, a poznan.pl kartę z kategoriami
 * zgody na ciasteczka. Karta jest niepodzielna, więc chrom wjeżdżał do modelu co dzień
 * i nie było jak go tknąć — pomiar 2026-08-20: 69 „kart" po 40% chromu i więcej,
 * 28 855 znaków, 12,2% masy wszystkich kart.
 *
 * Weto jest TREŚCIOWE i nakłada się na strukturalne zgadywanie: fragment, w którym przeważają
 * znaki chromu, wraca do podziału po akapitach. Rozstrzyga asymetria — takie „karty" nie dały
 * ani jednego wydarzenia od początku rejestru, a każda z nich kosztuje codziennie.
 */
describe("karta, która jest chromem", () => {
  /** mdk2.poznan.pl/aktualnosci — strona z rejestru, pobrana 2026-08-19 (patrz fixtures). */
  const MDK2 = readFileSync(
    fileURLToPath(new URL("fixtures/mdk2-poznan-aktualnosci-2026-08-19.html", import.meta.url)),
    "utf8",
  );

  it("spis oferty zajęć nie zostaje kartą", () => {
    const seg = segmentHtml(MDK2);
    const cards = new Set(seg.cardHashes);
    const oferta = seg.blocks.filter(
      (b) => cards.has(b.hash) && b.text.includes("/oferta-zajec/"),
    );
    assert.deepEqual(oferta.map((b) => b.chars), [], "drzewo oferty nadal liczy się jako karta");
  });

  it("treść nie ginie — spis nadal stoi w którymś bloku", () => {
    const seg = segmentHtml(MDK2);
    assert.ok(
      seg.blocks.some((b) => b.text.includes("/oferta-zajec/")),
      "unieważniona karta zniknęła ze strony zamiast wrócić do reszty",
    );
  });

  it("prawdziwe karty przeżywają weto", () => {
    const seg = segmentHtml(MDK2);
    assert.ok(seg.detected, "strona przestała być listą kart");
    assert.ok(seg.cards >= 10, `zostało tylko ${seg.cards} kart — weto zjadło listę`);
  });
});

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

/**
 * KARTA MUSI SIĘ PRZEDSTAWIĆ WŁASNYM ODNOŚNIKIEM.
 *
 * Wykrywanie kart pyta o STRUKTURĘ, a sekcje jednego wpisu („Harmonogram", „Program",
 * „Informacje organizacyjne") są równie samokształtnym rodzeństwem, co karty na liście.
 * Skutek zmierzony 2026-08-20 na okpoznan.pl (patrz fixture): strona JEDNEGO wydarzenia
 * rozpadła się na 12 „kart", a cache zapisał wydarzenie przy fragmencie na 231 znaków —
 * bloki z miejscem, godzinami i programem dostały ZERO wydarzeń. Odtworzenie jutrzejszego
 * przebiegu (dwa wywołania modelu) pokazało, co z tego wynika:
 *   - świeży sam blok-nosiciel → „WARSZTAT VI ARCHITEKCI MYŚLENIA", venue "", town "",
 *     godziny null (zamiast „Centrum Edukacyjne AMAkids, ul. Ścinawska 19", 7:30–16:30),
 *     i ta wersja NADPISUJE cache;
 *   - świeży sam blok z miejscem i godzinami → zero wydarzeń, czyli poprawka przepada.
 *
 * Odróżnia je jedno: karta na liście niesie WŁASNY adres wydarzenia, sekcja wpisu nie ma
 * żadnego albo dzieli go z sąsiadkami. To odwraca założenie z nagłówka dom-blocks.ts
 * („nadwykrycie jest tanie"): nadwykrycie kosztuje miejsce, godziny i tytuł wydarzenia,
 * a niedowykrycie na tak małej stronie kosztuje ~4% wywołania (3 925 vs ~4 000 tok.).
 */
describe("karta bez własnego odnośnika", () => {
  /** okpoznan.pl — strona JEDNEGO wydarzenia, pobrana 2026-08-20 (patrz fixtures). */
  const AMAKIDS = readFileSync(
    fileURLToPath(new URL("fixtures/okpoznan-amakids-2026-08-20.html", import.meta.url)),
    "utf8",
  );

  it("sekcje jednego wpisu nie zostają kartami", () => {
    const seg = segmentHtml(AMAKIDS);
    const cards = new Set(seg.cardHashes);
    const sekcje = seg.blocks.filter(
      (b) => cards.has(b.hash) && /Harmonogram Kursu|Informacje Organizacyjne/u.test(b.text),
    );
    assert.deepEqual(sekcje.map((b) => b.chars), [], "sekcja opisu nadal liczy się jako karta");
  });

  it("wydarzenie zostaje w JEDNYM bloku — tytuł, miejsce i godziny razem", () => {
    const seg = segmentHtml(AMAKIDS);
    const razem = seg.blocks.filter(
      (b) => b.text.includes("ARCHITEKCI MYŚLENIA")
        && b.text.includes("Ścinawska 19") && b.text.includes("7:30"),
    );
    assert.equal(razem.length, 1,
      "pola jednego wydarzenia rozjechały się po blokach — cache nie złoży ich z powrotem");
  });

  it("karty z paska „inne wydarzenia” przeżywają — mają własne adresy", () => {
    const seg = segmentHtml(AMAKIDS);
    const cards = new Set(seg.cardHashes);
    const inne = seg.blocks.filter(
      (b) => cards.has(b.hash) && b.text.includes("/szczegoly-wydarzenia/"),
    );
    assert.ok(inne.length >= 4, `zostało ${inne.length} kart paska — weto zjadło prawdziwą listę`);
  });

  it("treść nie ginie — opis nadal stoi w którymś bloku", () => {
    const seg = segmentHtml(AMAKIDS);
    assert.ok(
      seg.blocks.some((b) => b.text.includes("Harmonogram Kursu")),
      "unieważniona karta zniknęła ze strony zamiast wrócić do reszty",
    );
  });
});

/**
 * ADRES KARTY MA ZOSTAĆ PRZY KARCIE.
 *
 * okpoznan.pl/wydarzenia — cała lista wydarzeń pobrana 2026-08-21 (patrz fixtures), bez
 * nagłówka strony, stopki i widżetu kalendarza. Odnośnik owija tam CAŁĄ kartę
 * (`<a><article>…</article></a>`), więc renderer wypuszcza go dopiero ZA jej tekstem —
 * a granica z hasha akapitu potrafi wypaść dokładnie w tej szczelinie. Zostaje wtedy blok
 * mający w środku sam adres i nic poza nim.
 *
 * Kosztowało to konkretny wpis w digeście z 2026-08-21: „Wolsztyn. Historia napędzana parą"
 * poszedł z adresem listingu zamiast własnej podstrony (model słusznie NIE podstawił adresu
 * karty obok, choć ten stał w tym samym bloku). Bez własnego adresu nie było czego dociągnąć
 * followupem, więc wpis został bez godziny i z samą ulicą zamiast nazwy miejsca.
 */
describe("okpoznan.pl — odnośnik owinięty wokół karty", () => {
  /** okpoznan.pl/wydarzenia — lista wydarzeń, pobrana 2026-08-21 (patrz fixtures). */
  const OKPOZNAN = readFileSync(
    fileURLToPath(new URL("fixtures/okpoznan-wydarzenia-2026-08-21.html", import.meta.url)),
    "utf8",
  );

  /** Akapit, który jest SAMYM adresem — „[/adres]" i ani jednego słowa własnego. */
  const bareLink = (text: string): boolean => /^\[[^\]\s]+\]$/.test(text.trim());

  it("żaden blok nie jest samym odnośnikiem", () => {
    const orphans = segmentHtml(OKPOZNAN).blocks.filter((b) => bareLink(b.text));
    assert.deepEqual(
      orphans.map((b) => b.text.trim()), [],
      "blok bez ani jednego słowa własnego nie ma czego wnieść do ekstrakcji, "
      + "a karcie obok zabiera jej własny adres",
    );
  });

  it("karta Wolsztyna niesie SWÓJ adres, a nie tylko adres karty obok", () => {
    const seg = segmentHtml(OKPOZNAN);
    const card = seg.blocks.find((b) => b.text.includes("WOLSZTYN. HISTORIA NAPĘDZANA PARĄ"));
    assert.ok(card, "karta zniknęła ze strony");
    assert.ok(
      card.text.includes("wolsztyn-historia-napedzana-para"),
      `adres karty wypadł poza jej blok — model nie ma jak go przepisać:\n${card.text}`,
    );
  });

  it("adres nie ginie po drodze — każdy z listy stoi w którymś bloku", () => {
    // sedno: to NIE jest odsiew, tylko przesunięcie granicy. Gdyby poprawka gubiła adresy,
    // pierwszy test świeciłby na zielono z tego samego powodu, dla którego jest zły
    const seg = segmentHtml(OKPOZNAN);
    const all = seg.blocks.map((b) => b.text).join("\n");
    for (const slug of ["wolsztyn-historia-napedzana-para", "plenerowe-palacowe-2026",
      "staromiejskie-koncerty-organowe-2026"]) {
      assert.ok(all.includes(slug), `adres „${slug}" zniknął ze strony`);
    }
  });
});
