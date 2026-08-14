/**
 * Co NAPRAWDĘ idzie do modelu z prawdziwej strony — na zapisanym HTML-u poznan.pl.
 *
 * Powód istnienia, w liczbach z 2026-08-14 (`https://www.poznan.pl/mim/events/`):
 * 161 869 bajtów HTML-a → 29 075 znaków tekstu → 50 bloków, w tym 34 karty. Z 23 760 znaków
 * kart **4 021 (16.9%) to wiersze powtórzone w obrębie tej samej karty**, bo CMS wypuszcza
 * każdy kawałek karty dwa razy:
 *
 *   · `<img>` w `.image-events-desktop` i `.image-events-mobile` — ten sam `alt`, dwa wiersze;
 *   · kategorię w `category-after-click-events` i `category-before-click-events` — ten sam
 *     odnośnik dwa razy, przy karcie wielokategoryjnej raz rozwinięty, raz jako „+2";
 *   · adres wydarzenia w TRZECH odnośnikach: obrazek, tytuł, „Zobacz szczegóły".
 *
 * Do tego blok z menu i kalendarzem (2 664 znaki), którego cache NIE MA JAK trafić: stoi
 * w nim `14 [/mim/events/2026-08-14/?sort=new&count=20]`, więc jutro ten sam blok ma inny
 * hash i jedzie do modelu od nowa. Codziennie, w nieskończoność, za zero wydarzeń.
 *
 * DANE SĄ PRAWDZIWE i mają takie zostać — `test/fixtures/` trzyma dwie strony pobrane z
 * serwisu 2026-08-14. Druga (`.../2026-08-15/`) służy WYŁĄCZNIE do sprawdzenia dryfu menu:
 * karty ma własne (inne adresy, inny dzień), więc niczego innego nie wolno na niej opierać.
 *
 * Wszystkie trzy reguły powstały jako CZERWONE i takie zostały opisane; zieleni je
 * `thinCard` (dom-blocks.ts) i `stableKey` (blocks.ts). Po poprawce karty chudną
 * z 23 894 do 18 692 znaków (−21.8%), a menu z kalendarzem przestaje wracać do modelu.
 * Ostatni zestaw jest strażnikiem: pilnuje, żeby czystsza karta nie została kupiona za
 * lokalność cache'a (odsiew powtórek liczony po CAŁEJ stronie uzależniłby treść karty
 * od jej sąsiadek i skasował cały zysk z podziału na bloki).
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { segmentHtml } from "../src/pipeline/extract/dom-blocks.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");

const LISTA = fixture("poznan-events-lista.html");
const NASTEPNY_DZIEN = fixture("poznan-events-2026-08-15.html");

const seg = segmentHtml(LISTA);
const cardSet = new Set(seg.cardHashes);
const cards = seg.blocks.filter((b) => cardSet.has(b.hash));

/**
 * Karty WYDARZEŃ, czyli te z widoczną datą — i tylko o nich mówi reguła o powtórzonych
 * wierszach. Podział po DOM-ie uznaje za karty także kolumny mega-menu serwisu (są równie
 * powtarzalnym rodzeństwem) i tam „ten sam wiersz dwa razy" znaczy co innego: nagłówek
 * sekcji ma te same słowa, co odnośnik pod nim. Zlepienie tego byłoby kasowaniem treści,
 * a nie powtórki, więc reguła ma o tym nie mówić — po poprawce zostaje tam 175 znaków
 * powtórek i to jest chrom do osobnej roboty, nie ten defekt.
 */
const eventCards = cards.filter((b) => /\d{2}\.\d{2}\.\d{4}/u.test(b.text));

const lines = (text: string): string[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Adresy wyłuskane z tekstu karty — i te w nawiasach, i te stojące samopas po `<a>` z obrazkiem. */
const urlsIn = (text: string): string[] =>
  [...text.matchAll(/(?:\[|\s|^)((?:https?:\/\/|\/)[^\s\]]+)/gmu)].map((m) => m[1] ?? "");

/** Adresy powtórzone W OBRĘBIE jednego bloku, z krotnością. */
function repeatedUrls(text: string): [string, number][] {
  const licznik = new Map<string, number>();
  for (const u of urlsIn(text)) licznik.set(u, (licznik.get(u) ?? 0) + 1);
  return [...licznik.entries()].filter(([, n]) => n > 1);
}

/** Ile znaków karty to wiersz, który w tej samej karcie już stał. */
function duplicateChars(text: string): number {
  const seen = new Set<string>();
  let dup = 0;
  for (const l of lines(text)) {
    if (seen.has(l)) dup += l.length + 1;
    seen.add(l);
  }
  return dup;
}

const preview = (text: string): string => lines(text)[0]?.slice(0, 60) ?? "(pusta)";

describe("karta z poznan.pl — powtórzone wiersze", () => {
  it("fixture jest tą stroną, o której mówi opis testu", () => {
    // gdy serwis przebuduje listę, ten test ma powiedzieć „zmieniły się dane", a nie
    // sypnąć trzema niezrozumiałymi porażkami niżej
    assert.equal(seg.detected, true, "podział po DOM-ie ma rozpoznać listę kart");
    assert.equal(seg.cards, 34, "34 karty — tyle miała strona z 2026-08-14");
  });

  it("żaden wiersz nie stoi w karcie wydarzenia dwa razy", () => {
    const offenders = eventCards
      .map((b) => ({ b, dup: duplicateChars(b.text) }))
      .filter(({ dup }) => dup > 0);
    const dupChars = offenders.reduce((s, o) => s + o.dup, 0);
    const allChars = eventCards.reduce((s, b) => s + b.chars, 0);

    assert.equal(offenders.length, 0,
      `${offenders.length} z ${eventCards.length} kart powtarza własne wiersze — `
      + `${dupChars} z ${allChars} znaków (${(100 * dupChars / allChars).toFixed(1)}%) idzie do modelu dwa razy.\n`
      + offenders.slice(0, 5).map(({ b, dup }) => `    · +${dup} zn.: ${preview(b.text)}`).join("\n")
      + "\n  POTOK: `thinCard` w dom-blocks.ts ma zerować `alt` powtórzonego obrazka — dwa "
      + "`<img>` z tym samym opisem (desktop i mobile) to jeden obrazek, nie dwa.");
  });

  it("adres stoi w karcie najwyżej raz", () => {
    const offenders: string[] = [];
    for (const b of cards) {
      for (const [u, n] of repeatedUrls(b.text)) offenders.push(`×${n} ${u}  (karta: ${preview(b.text)})`);
    }

    assert.equal(offenders.length, 0,
      `${offenders.length} adresów powtórzonych w obrębie karty:\n`
      + offenders.slice(0, 6).map((o) => `    · ${o}`).join("\n")
      + "\n  POTOK: adres wydarzenia niosą trzy odnośniki (obrazek, tytuł, „Zobacz szczegóły”), "
      + "a kategorię dwa — `thinCard` w dom-blocks.ts zostawia `href` przy odnośniku z własnym "
      + "tekstem i zdejmuje z reszty. Odsiew MUSI być lokalny dla karty; patrz ostatni zestaw.");
  });
});

describe("menu z kalendarzem — blok, którego cache nie ma jak trafić", () => {
  /** Podpis treści menu: kalendarz i lista kategorii. Nie zależy od tego, jak wypadną granice bloków. */
  const MENU = "WYBIERZ KATEGORIĘ";

  it("nie wraca do modelu następnego dnia", () => {
    const znane = new Set(seg.blocks.map((b) => b.hash));
    const swieze = segmentHtml(NASTEPNY_DZIEN).blocks.filter((b) => !znane.has(b.hash));
    const menu = swieze.filter((b) => b.text.includes(MENU) || /\d+ \[\/mim\/events\/20\d\d-\d\d-\d\d\/\]/u.test(b.text));

    assert.equal(menu.length, 0,
      `menu z kalendarzem jedzie do modelu drugi raz — ${menu.reduce((s, b) => s + b.chars, 0)} znaków `
      + `w ${menu.length} bloku/blokach, mimo że treść jest ta sama:\n`
      + menu.map((b) => `    · ${b.chars} zn.: ${preview(b.text)}`).join("\n")
      + "\n  POTOK: hash bloku ma nie zależeć od odnośnika `/RRRR-MM-DD/`, który przesuwa się "
      + "co dobę (dzień „dziś” w kalendarzu, poprzedni/następny miesiąc). Wersja: maskować "
      + "segment daty w adresie PRZED liczeniem hasza, tekst do modelu zostawiając bez zmian.");
  });
});

describe("lokalność bloków na prawdziwej stronie (strażnik poprawek wyżej)", () => {
  /** Wycięcie jednej karty z HTML-a — dokładnie to, co robi serwis, gdy wydarzenie się kończy. */
  function bezJednejKarty(html: string): string {
    const start = html.indexOf('<article class="event-box"');
    assert.ok(start > 0, "fixture ma mieć karty w `article.event-box`");
    const koniec = html.indexOf("</article>", start) + "</article>".length;
    return html.slice(0, start) + html.slice(koniec);
  }

  it("usunięcie jednej karty unieważnia dokładnie jeden blok", () => {
    const znane = new Set(seg.blocks.map((b) => b.hash));
    const swieze = segmentHtml(bezJednejKarty(LISTA)).blocks.filter((b) => !znane.has(b.hash));

    assert.equal(swieze.length, 0,
      `po usunięciu jednej karty ${swieze.length} bloków przestało pasować do cache'a — `
      + "znaczy, że treść bloku zależy od jego sąsiadów:\n"
      + swieze.map((b) => `    · ${b.chars} zn.: ${preview(b.text)}`).join("\n")
      + "\n  POTOK: odsiew powtórek liczony po całej stronie (a nie w obrębie karty) wiąże "
      + "karty ze sobą i kasuje cały zysk z cache'a. Odsiew ma być lokalny.");
  });
});
