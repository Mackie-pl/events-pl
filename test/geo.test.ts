/**
 * Filtr geograficzny discovery. Testujemy go, bo jego pomyłka nie wywala niczego — po cichu
 * zmienia ZASIĘG projektu: za ciasny filtr gubi gminy, za luźny mnoży zapytania do Serpera
 * po ~10 na gminę. Jedno i drugie widać dopiero po przebiegu, który już kosztował.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { type Bounds, distanceToBounds, stripGmina } from "../src/adapters/overpass.js";

// prostokąt granic Poznania z OSM (2026-08-01) — ~24 km w poziomie, ~24 km w pionie
const POZNAN: Bounds = { minlat: 52.2919238, minlon: 16.7315878, maxlat: 52.5093282, maxlon: 17.0717065 };

describe("distanceToBounds", () => {
  it("punkt wewnątrz prostokąta ma odległość zero", () => {
    assert.equal(distanceToBounds(52.40, 16.92, POZNAN), 0);
    assert.equal(distanceToBounds(POZNAN.minlat, POZNAN.minlon, POZNAN), 0);
  });

  it("mierzy od KRAWĘDZI, nie od środka", () => {
    // 0.09° na północ od górnej krawędzi ≈ 10 km; od środka byłoby ponad 20
    const km = distanceToBounds(POZNAN.maxlat + 0.09, 16.92, POZNAN);
    assert.ok(km > 9 && km < 11, `${km} km`);
  });

  it("uwzględnia zbieżność południków", () => {
    // ten sam przyrost w stopniach: na wschód krócej niż na północ (cos 52° ≈ 0.62)
    const north = distanceToBounds(POZNAN.maxlat + 0.1, 16.92, POZNAN);
    const east = distanceToBounds(52.40, POZNAN.maxlon + 0.1, POZNAN);
    assert.ok(east < north * 0.7, `wschód ${east} vs północ ${north}`);
  });

  it("po skosie liczy przeponę, a nie sumę boków", () => {
    const diag = distanceToBounds(POZNAN.maxlat + 0.09, POZNAN.maxlon + 0.145, POZNAN);
    const north = distanceToBounds(POZNAN.maxlat + 0.09, 16.92, POZNAN);
    const east = distanceToBounds(52.40, POZNAN.maxlon + 0.145, POZNAN);
    assert.ok(diag < north + east, "skos nie może być dłuższy niż suma boków");
    assert.ok(Math.abs(diag - Math.hypot(north, east)) < 0.5, `${diag} vs ${Math.hypot(north, east)}`);
  });

  it("jest symetryczna względem krawędzi", () => {
    const above = distanceToBounds(POZNAN.maxlat + 0.05, 16.92, POZNAN);
    const below = distanceToBounds(POZNAN.minlat - 0.05, 16.92, POZNAN);
    assert.ok(Math.abs(above - below) < 0.1, `${above} vs ${below}`);
  });
});

describe("stripGmina", () => {
  it("zdejmuje prefiks OSM, bo trafiłby do zapytań wyszukiwarki", () => {
    assert.equal(stripGmina("gmina Komorniki"), "Komorniki");
    assert.equal(stripGmina("Gmina Tarnowo Podgórne"), "Tarnowo Podgórne");
  });

  it("nie rusza nazw, które prefiksu nie mają", () => {
    for (const n of ["Poznań", "Luboń", "Puszczykowo"]) assert.equal(stripGmina(n), n);
  });

  it("nie ucina prefiksu w środku ani sklejonego z nazwą", () => {
    assert.equal(stripGmina("Nowa gmina Wieś"), "Nowa gmina Wieś");
    assert.equal(stripGmina("Gminatyn"), "Gminatyn");
  });
});
