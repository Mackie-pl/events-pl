/**
 * Geokoder na ŻYWO: czy miejsca, które audit zgłosił jako „geokoder nie zna tego adresu",
 * faktycznie dostają współrzędne.
 *
 * Komplet z auditu 2026-08-14 — dziewięć zwyczajnych poznańskich miejsc, wszystkie z
 * `hit=false`. Żadnego z nich nie brakowało w OSM: całą dziewiątkę gubił sposób zadawania
 * pytania (zlepek „nazwa, adres" w jednym `q` plus prefiks „ul."). Ten zestaw pilnuje, żeby
 * poprawka z `adapters/nominatim.ts` nie cofnęła się przy kolejnym strojeniu drabinki.
 *
 * Osobno od `npm test`, bo puka do publicznego Nominatima: ~1,1 s na zapytanie i realna
 * szansa na 503, gdy usługa ma gorszy dzień.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { geocode } from "../../src/adapters/nominatim.js";

/** Prostokąt „Poznań i okolice" — pinezka poza nim znaczy trafienie w losowe miejsce w Polsce. */
const AREA = { minlat: 52.2, maxlat: 52.6, minlon: 16.6, maxlon: 17.2 };

// dokładnie te stringi, które trafiły do auditu
const VENUES: Array<[venue: string, town: string]> = [
  ["Park Cytadela w Poznaniu, Lasek Marceliński w Poznaniu, Las Dębiński w Poznaniu", "Poznań"],
  ["Muzeum Broni Pancernej w Poznaniu, ul. 3. Pułku Lotniczego 4", "Poznań"],
  ["Hipodrom Wola, ul. Lutycka 34", "Poznań"],
  ["Tor Poznań, ul. Wyścigowa 3", "Przeźmierowo"],
  ["Park Wilsona, ul. Śniadeckich 30", "Poznań"],
  ["Park Górczyński, ul. Ostrobramska 35", "Poznań"],
  ["Start: przy fontannie na placu Wolności", "Poznań"],
  ["Dom Kultury Orle Gniazdo, os. Lecha 43", "Poznań"],
  ["Sala kolumnowa, Akademia Lubrańskiego, ul. Lubrańskiego 1 (Ostrów Tumski)", "Poznań"],
];

/**
 * Drugie podejście: miejsca z `state.json`, które zostały na placu boju po pierwszej wersji
 * drabinki. Każde ma inny powód — dopowiedzenie po myślniku, ogon przyimkowy, miejscowość
 * sklejona z ulicą bez przecinka.
 */
const HARD: Array<[venue: string, town: string]> = [
  ["Mosina ul. Jana Cybisa 4 - garaż", "Poznań"],
  ["Park nad Wartą przy amfiteatrze", "Poznań"],
];

describe("geocode — miejsca z auditu „geokoder nie zna tego adresu”", () => {
  it("znajduje wszystkie i stawia pinezkę w okolicy Poznania", { timeout: 180_000 }, async () => {
    const cache: Record<string, { lat: number; lon: number } | null> = {};
    const misses: string[] = [];
    const strays: string[] = [];

    for (const [venue, town] of [...VENUES, ...HARD]) {
      const g = await geocode(venue, town, cache);
      if (!g) { misses.push(`„${venue}" (${town})`); continue; }
      if (g.lat < AREA.minlat || g.lat > AREA.maxlat || g.lon < AREA.minlon || g.lon > AREA.maxlon) {
        strays.push(`„${venue}" → ${g.lat}, ${g.lon}`);
      }
    }

    assert.deepEqual(misses, [], `geokoder nie znalazł:\n    ${misses.join("\n    ")}\n`
      + "  POTOK: drabinka w `geoQueries()` (adapters/nominatim.ts) nie rozbiła tego venue "
      + "na człon, który Nominatim rozumie — dopisz przypadek do test/geo-queries.test.ts.");

    assert.deepEqual(strays, [], `pinezka poza aglomeracją:\n    ${strays.join("\n    ")}\n`
      + "  POTOK: `inTown()` przepuścił trafienie z innej miejscowości — zawęź próg "
      + "dopasowania miasta w adapters/nominatim.ts.");
  });
});
