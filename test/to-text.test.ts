/**
 * `toText` — co ląduje w prompcie i w haszach bloków.
 *
 * Powód testu w liczbach: strona pojedynczego wydarzenia mosina.pl (2026-08-12) ma 1 046 664
 * bajtów HTML-a, z czego 640 938 to DWA obrazki wklejone jako `data:image/jpeg;base64`.
 * html-to-text renderuje obrazek jako „alt [src]", więc cały base64 wchodził do tekstu:
 * 648 279 znaków, ucięte do limitu wejścia i wysłane modelowi po jedno wydarzenie. Base64
 * tokenizuje się ~1 znak/token, więc samo to źródło zjadło 84 488 tokenów wejścia ($0.096) —
 * 12% rachunku całego dnia.
 *
 * Drugi kierunek jest równie ważny: zwykłe `src` MUSZĄ zostać. Followupy-plakaty biorą się
 * właśnie z adresów obrazków w tekście, więc wycięcie ich wszystkich kupiłoby te same znaki
 * kosztem całej ścieżki plakatowej.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { toText } from "../src/adapters/page-fetch.js";

const BASE64 = "/9j/4AAQSkZJRgABAQEAYABgAAD".repeat(400);

describe("toText — obrazki wklejone w stronę", () => {
  it("zdejmuje ładunek base64, zostawia sam typ jako ślad", () => {
    const html = `<p>Koncert w parku</p><img alt="Plakat" src="data:image/jpeg;base64,${BASE64}">`;
    const text = toText(html);

    assert.ok(!text.includes(BASE64.slice(0, 40)), "ładunek base64 nie wchodzi do tekstu");
    assert.ok(text.includes("data:image/jpeg"), "typ zostaje — było tu coś obrazkowego");
    assert.ok(text.length < 200, `tekst ma zostać krótki, ma ${text.length} znaków`);
  });

  it("nie gubi treści wokół obrazka", () => {
    const html = `<p>Koncert w parku</p><img alt="Plakat" src="data:image/png;base64,${BASE64}"><p>Wstęp wolny</p>`;
    const text = toText(html);

    assert.ok(text.includes("Koncert w parku"));
    assert.ok(text.includes("Wstęp wolny"));
    assert.ok(text.includes("Plakat"), "alt niesie treść i zostaje");
  });

  it("zwykłe adresy obrazków zostają nietknięte — z nich biorą się followupy-plakaty", () => {
    const text = toText(`<img alt="Plakat" src="https://gok.test/plakaty/lato-2026.jpg">`);
    assert.ok(text.includes("https://gok.test/plakaty/lato-2026.jpg"));
  });

  it("adres zwykłego odnośnika też zostaje — followupy biorą się i stąd", () => {
    const text = toText(`<a href="https://gok.test/wydarzenia/koncert">Koncert</a>`);
    assert.ok(text.includes("https://gok.test/wydarzenia/koncert"));
  });

  it("`data:` w treści strony nie psuje zdania", () => {
    // regexp chodzi po całym HTML-u, więc musi być obojętny dla tekstu, który tylko WYGLĄDA
    // jak URI — inaczej cicho zjadłby kawałek zdania i hash bloku przestałby pasować
    const text = toText("<p>Format data:image/png jest wspierany.</p>");
    assert.equal(text.trim(), "Format data:image/png jest wspierany.");
  });
});
