/**
 * Prostokąt geograficzny — jedno miejsce, w którym stoi przelicznik km → stopnie.
 *
 * Wydzielone 2026-08-21, kiedy geokoder zaczął potrzebować DOKŁADNIE tego prostokąta,
 * który discovery liczy dla Overpassa. Powielenie czterech linii geometrii znaczyłoby, że
 * „region" w `discover` i „region" w `nominatim` mogą się kiedyś rozjechać o promień —
 * a rozjazd byłby cichy: gminy nadal by się znajdowały, tylko wydarzenia z brzegu zaczęłyby
 * wypadać poza prostokąt bez śladu.
 *
 * Equirectangular, bo na 15–30 km błąd rzutowania jest poniżej pojedynczych metrów, a
 * czytelność wzoru ma tu większą wartość niż dokładność, której i tak nie wykorzystujemy.
 */

/** Prostokąt w stopniach — ten sam kształt, którym Overpass opisuje granice relacji. */
export interface Bounds { minlat: number; minlon: number; maxlat: number; maxlon: number }

export const KM_PER_DEG_LAT = 110.574;
export const kmPerDegLon = (lat: number): number => 111.320 * Math.cos((lat * Math.PI) / 180);

/**
 * Odległość punktu od prostokąta (0 w środku).
 * Wyeksportowane dla testu: cicha pomyłka w znaku albo w przelicznikach nie wywala niczego,
 * tylko po cichu zmienia zasięg projektu, a to widać dopiero po rachunku za Serpera.
 */
export function distanceToBounds(lat: number, lon: number, b: Bounds): number {
  const dLat = Math.max(b.minlat - lat, 0, lat - b.maxlat) * KM_PER_DEG_LAT;
  const dLon = Math.max(b.minlon - lon, 0, lon - b.maxlon) * kmPerDegLon(lat);
  return Math.hypot(dLat, dLon);
}

/**
 * Prostokąt rozszerzony o promień. Nadmiarowy w rogach (√2·R zamiast R) — to filtr WSTĘPNY,
 * a właściwe przycięcie robi `distanceToBounds`. Punkt podajemy jako zdegenerowany prostokąt,
 * więc ta sama funkcja obsługuje granice miasta i środek regionu z `sources.json`.
 */
export function padBounds(b: Bounds, radiusKm: number): Bounds {
  const padLat = radiusKm / KM_PER_DEG_LAT;
  const padLon = radiusKm / kmPerDegLon((b.minlat + b.maxlat) / 2);
  return {
    minlat: b.minlat - padLat, minlon: b.minlon - padLon,
    maxlat: b.maxlat + padLat, maxlon: b.maxlon + padLon,
  };
}

/** Punkt jako prostokąt o zerowym boku — wejście dla `padBounds`. */
export const pointBounds = (p: { lat: number; lon: number }): Bounds =>
  ({ minlat: p.lat, minlon: p.lon, maxlat: p.lat, maxlon: p.lon });
