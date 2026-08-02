/**
 * Overpass API (OSM, darmowe) — lista gmin w promieniu od miasta centralnego.
 *
 * Dwa zapytania zamiast jednego, świadomie. Naturalne `(around.<zbiór>:R)` wokół relacji
 * granicznej miasta NIE działa: sonda z 2026-08-01 zwróciła 0 elementów po 123 sekundach —
 * `around` liczy odległość od węzłów zbioru, a relacja sama w sobie żadnych nie wnosi.
 * Zapytanie po bboksie jest indeksowane i schodzi do ~9 s dla Poznania, a odległość i tak
 * musimy policzyć u siebie, żeby prostokąt przyciąć do promienia.
 */
import { describeError } from "../shared/errors.js";
import type { GeoLookup } from "../types/index.js";

import { fetchUrl } from "./http.js";

const OVERPASS_URL = process.env["OVERPASS_URL"] ?? "https://overpass-api.de/api/interpreter";

/**
 * Overpass odbija HTTP 406 request bez własnego User-Agenta — ich usage policy wymaga
 * nagłówka, po którym da się namierzyć autora obciążającego zapytania.
 *
 * Świadomie NIE `BROWSER_HEADERS`: to jedyny odruch, który tu NIE działa. Sonda z 2026-08-01
 * (ten sam query, cztery zestawy nagłówków) dała 406 dla braku UA, 406 dla Chrome UA — także
 * z `Accept: application/json` — i 200 dopiero dla UA nazywającego aplikację. Decyduje sam
 * User-Agent; udawanie przeglądarki jest tu przeciwskuteczne.
 */
const OVERPASS_HEADERS = {
  "User-Agent": "events-pl/1.0 (+https://github.com/Mackie-pl/events-pl)",
  Accept: "application/json",
};

/**
 * Czy błąd jest NASZ, czy ich. Fallback na samo miasto centralne wygląda tak samo w obu
 * przypadkach, a to zupełnie różne naprawy: 4xx nie minie samo i będzie się powtarzać do
 * skutku w kodzie, 5xx i 429 przejdą przy kolejnym przebiegu. Rozróżnienie idzie do logu
 * i do raportu, bo poprzednim razem trwały błąd konfiguracji czytał się jak przeciążenie.
 */
const statusKind = (status: number): string =>
  status === 429 ? "limit zapytań, spróbuj później"
    : status < 500 ? "odrzucony request — błąd po NASZEJ stronie"
      : "awaria serwera Overpass";

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat: number): number => 111.320 * Math.cos((lat * Math.PI) / 180);

export interface Bounds { minlat: number; minlon: number; maxlat: number; maxlon: number }

interface OverpassElement {
  tags?: Record<string, string>;
  bounds?: Bounds;
  center?: { lat: number; lon: number };
}

/** Jedno zapytanie do Overpass wraz z rozpakowaniem `elements`. Rzuca z gotowym komunikatem. */
async function overpass(q: string, onStatus: (s: number) => void): Promise<OverpassElement[]> {
  const res = await fetchUrl(OVERPASS_URL, {
    method: "POST",
    headers: OVERPASS_HEADERS,
    body: new URLSearchParams({ data: q }),
  }, 90_000);
  if (!res.ok) {
    onStatus(res.status);
    throw new Error(`Overpass HTTP ${res.status} (${statusKind(res.status)})`);
  }
  const json = (await res.json()) as { elements?: OverpassElement[] };
  return json.elements ?? [];
}

/**
 * Granice miasta centralnego. Kolejność preferencji, a nie sztywny admin_level: w OSM ten sam
 * Poznań jest relacją na poziomie 6 (powiat grodzki), 7 (gmina) i 8 (miasto), a interesuje nas
 * gmina. Miasta bez własnego powiatu bywają tylko ósemką, więc bierzemy pierwszy trafiony
 * poziom z listy zamiast zakładać, że siódemka istnieje zawsze.
 */
function pickCenter(els: OverpassElement[]): Bounds | undefined {
  for (const level of ["7", "8", "6"]) {
    const hit = els.find((e) => e.tags?.["admin_level"] === level && e.bounds);
    if (hit?.bounds) return hit.bounds;
  }
  return els.find((e) => e.bounds)?.bounds;
}

/**
 * Odległość punktu od prostokąta (0 w środku). Equirectangular — na 15–30 km wystarcza.
 * Wyeksportowane dla testu: cicha pomyłka w znaku albo w przelicznikach nie wywala niczego,
 * tylko po cichu zmienia zasięg projektu, a to widać dopiero po rachunku za Serpera.
 */
export function distanceToBounds(lat: number, lon: number, b: Bounds): number {
  const dLat = Math.max(b.minlat - lat, 0, lat - b.maxlat) * KM_PER_DEG_LAT;
  const dLon = Math.max(b.minlon - lon, 0, lon - b.maxlon) * kmPerDegLon(lat);
  return Math.hypot(dLat, dLon);
}

/**
 * „gmina Komorniki" → „Komorniki". OSM trzyma prefiks w `name` dla gmin wiejskich, a on trafiłby
 * prosto do zapytań wyszukiwarki („gmina Komorniki dom kultury"), zawężając je bez potrzeby.
 */
export const stripGmina = (name: string): string => name.replace(/^gmina\s+/i, "").trim();

/**
 * Prostokąt miasta rozszerzony o promień, w formacie bboksu Overpass. Nadmiarowy w rogach
 * (√2·R zamiast R), ale to filtr WSTĘPNY — właściwe przycięcie robi `distanceToBounds`.
 */
function paddedBox(center: Bounds, radiusKm: number): string {
  const padLat = radiusKm / KM_PER_DEG_LAT;
  const padLon = radiusKm / kmPerDegLon((center.minlat + center.maxlat) / 2);
  return [
    center.minlat - padLat, center.minlon - padLon,
    center.maxlat + padLat, center.maxlon + padLon,
  ].map((n) => n.toFixed(5)).join(",");
}

/** Gminy (admin_level 7) w promieniu od granic miasta centralnego. */
export async function townsInRadius(centerTown: string, radiusKm: number): Promise<GeoLookup> {
  const query = `Overpass: gminy (admin_level 7) w promieniu ${radiusKm} km od granic "${centerTown}"`;
  const geo: GeoLookup = { query, towns: [], ms: 0 };
  const t0 = performance.now();
  const onStatus = (s: number): void => { geo.httpStatus = s; };
  try {
    const center = pickCenter(await overpass(
      `[out:json][timeout:30];
       relation["name"="${centerTown}"]["boundary"="administrative"]["admin_level"~"6|7|8"];
       out ids bb;`,
      onStatus,
    ));
    if (!center) throw new Error(`OSM nie zna granic administracyjnych dla "${centerTown}"`);

    const candidates = await overpass(
      `[out:json][timeout:60];
       relation["boundary"="administrative"]["admin_level"="7"](${paddedBox(center, radiusKm)});
       out tags center;`,
      onStatus,
    );
    geo.considered = candidates.length;

    const names = new Set<string>([centerTown]);
    for (const el of candidates) {
      const name = el.tags?.["name"];
      if (!name || !el.center) continue;
      if (distanceToBounds(el.center.lat, el.center.lon, center) <= radiusKm) names.add(stripGmina(name));
    }
    geo.towns = [...names].sort();
    return geo;
  } catch (e) {
    // Overpass bywa przeciążony. Padnięcie na tym etapie kosztowało cały przebieg;
    // sensowniejsze jest discovery samego miasta centralnego i wyraźna adnotacja w raporcie.
    geo.err = describeError(e);
    geo.fallback = true;
    geo.towns = [centerTown];
    console.warn(`Overpass padł (${geo.err}) — discovery tylko dla "${centerTown}"`);
    // 4xx to nie degradacja, tylko zepsuty przebieg: pomiar --reset obejmie jedną gminę
    // zamiast kilkunastu, a raport i tak powie „adresy NIE wróciły". Ostrzeżenie ma być
    // głośniejsze niż samo padnięcie, bo naprawa jest w kodzie, nie w powtórzeniu.
    if (geo.httpStatus !== undefined && geo.httpStatus < 500 && geo.httpStatus !== 429) {
      console.warn("  ⚠️ to NIE jest przeciążenie — Overpass odrzucił nasz request; " +
        "powtórzenie przebiegu nic nie zmieni, dopóki nie poprawimy zapytania/nagłówków");
    }
    return geo;
  } finally {
    geo.ms = Math.round(performance.now() - t0);
  }
}
