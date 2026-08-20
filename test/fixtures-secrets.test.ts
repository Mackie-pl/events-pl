/**
 * Fixtury to prawdziwe strony pobrane z sieci, a repo jest publiczne — więc razem ze stroną
 * wjeżdżają tu cudze poświadczenia. 2026-08-20: klucz Google Maps Embed z okpoznan.pl leżał
 * w `okpoznan-amakids-2026-08-20.html` (commit d2e2b01, już wypchnięty). Klucz embedu jest jawny
 * z natury — leci w HTML do każdego odwiedzającego — więc nie chodzi o cudze bezpieczeństwo,
 * tylko o to, żeby nie hostować cudzego limitu i nie zapalać secret scanningu na NASZYM repo.
 *
 * Fixtury dokładamy ręcznie, więc bez bramki ten sam wiersz wraca przy następnej pobranej stronie.
 * Bramka patrzy na KSZTAŁT poświadczenia, nie na konkretny klucz: nowa strona z nowym kluczem
 * wywala się tak samo, bez oglądania jej przez nikogo.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("fixtures/", import.meta.url));

/**
 * Prefiksy, po których poświadczenie poznaje się bez zgadywania entropii. Ostatnia pozycja
 * łapie sekret nazwany wprost w URL-u — `key=` bez nazwy jest w scrapowanym HTML-u zbyt częste
 * (paginacja, cache-buster), żeby dało się na nim oprzeć bramkę bez fałszywych alarmów.
 */
const KSZTALTY: readonly { readonly nazwa: string; readonly wzorzec: RegExp }[] = [
  { nazwa: "klucz Google API", wzorzec: /AIzaSy[0-9A-Za-z_-]{33}/g },
  { nazwa: "klucz OpenAI", wzorzec: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { nazwa: "token GitHuba", wzorzec: /\bgh[pousr]_[A-Za-z0-9]{36}/g },
  { nazwa: "klucz AWS", wzorzec: /\bAKIA[0-9A-Z]{16}\b/g },
  { nazwa: "token Slacka", wzorzec: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { nazwa: "sekret nazwany w URL-u", wzorzec: /(?:api[_-]?key|access[_-]?token|client[_-]?secret)=[A-Za-z0-9_-]{20,}/gi },
];

const pliki = (katalog: string): string[] =>
  readdirSync(katalog, { withFileTypes: true }).flatMap((wpis) =>
    wpis.isDirectory() ? pliki(join(katalog, wpis.name)) : [join(katalog, wpis.name)]);

/** Komunikat porażki idzie do logów CI, więc trafia tam kształt i długość, nigdy sam sekret. */
const maska = (trafienie: string): string => `${trafienie.slice(0, 6)}…(${trafienie.length} zn.)`;

const wiersz = (tresc: string, pozycja: number): number => tresc.slice(0, pozycja).split("\n").length;

describe("fixtury nie niosą cudzych poświadczeń", () => {
  it("żaden plik w test/fixtures nie ma w sobie kształtu klucza ani tokenu", () => {
    const trafienia: string[] = [];

    for (const plik of pliki(FIXTURES)) {
      const tresc = readFileSync(plik, "utf8");
      for (const { nazwa, wzorzec } of KSZTALTY) {
        for (const dopasowanie of tresc.matchAll(wzorzec)) {
          const gdzie = `${relative(FIXTURES, plik)}:${wiersz(tresc, dopasowanie.index)}`;
          trafienia.push(`  ${gdzie} — ${nazwa} ${maska(dopasowanie[0])}`);
        }
      }
    }

    assert.deepEqual(trafienia, [], [
      "Fixtura niesie cudze poświadczenie:",
      ...trafienia,
      "Podmień samą WARTOŚĆ na REDACTED — kształt strony ma zostać prawdziwy, sekret nie.",
    ].join("\n"));
  });
});
