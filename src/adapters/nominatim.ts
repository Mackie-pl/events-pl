/** Geokoder Nominatim (OSM): darmowy, ale twardo 1 zapytanie/s i banuje za brak User-Agenta. */
import { setTimeout as sleep } from "node:timers/promises";

import { describeError } from "../shared/errors.js";
import type { PipelineState } from "../types/index.js";

import { fetchUrl } from "./http.js";

// Nominatim wymaga UA identyfikującego aplikację (usage policy) — tu zostaje bot.
const UA = { "User-Agent": "LocalEventsBot/0.3 (+kontakt: twoj@email)" };

/** Zapytania do geokodera w tym przebiegu — wolumen do costs.json (kategoria `geo`). */
let geoLookups = 0;

export const geoStats = (): number => geoLookups;
export function resetGeoStats(): void { geoLookups = 0; }

export async function geocode(
  venue: string, town: string, cache: PipelineState["geo"],
): Promise<{ lat: number; lon: number } | null> {
  const key = `${venue}|${town}`;
  if (key in cache) return cache[key] ?? null;
  const q = town ? `${venue}, ${town}, Poland` : `${venue}, Poland`;
  geoLookups += 1;
  try {
    const res = await fetchUrl(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "json", limit: "1" }).toString()}`,
      { headers: UA },
      15_000,
    );
    const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = hits[0];
    cache[key] = hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
  } catch (e) {
    console.warn(`geocode "${q}": ${describeError(e)}`);
    cache[key] = null;
  }
  await sleep(1_100); // polityka Nominatim
  return cache[key] ?? null;
}
