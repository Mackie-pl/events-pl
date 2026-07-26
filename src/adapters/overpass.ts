/** Overpass API (OSM, darmowe) — lista gmin w promieniu od miasta centralnego. */
import { describeError } from "../shared/errors.js";
import type { GeoLookup } from "../types/index.js";

import { fetchUrl } from "./http.js";

const OVERPASS_URL = process.env["OVERPASS_URL"] ?? "https://overpass-api.de/api/interpreter";

/** Gminy w promieniu — Overpass API (OSM, darmowe): admin_level 7/8 wokół miasta. */
export async function townsInRadius(centerTown: string, radiusKm: number): Promise<GeoLookup> {
  const geo: GeoLookup = { query: `Overpass: admin_level 7|8 w promieniu ${radiusKm} km od "${centerTown}"`, towns: [], ms: 0 };
  const t0 = performance.now();
  try {
    const q = `
      [out:json][timeout:30];
      area["name"="${centerTown}"]["boundary"="administrative"]->.c;
      ( relation["boundary"="administrative"]["admin_level"~"7|8"](around.c:${radiusKm * 1000}); );
      out tags center;`;
    const res = await fetchUrl(OVERPASS_URL, {
      method: "POST",
      body: new URLSearchParams({ data: q }),
    }, 60_000);
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
    const names = new Set<string>([centerTown]);
    for (const el of json.elements ?? []) {
      const name = el.tags?.["name"];
      if (name) names.add(name);
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
    return geo;
  } finally {
    geo.ms = Math.round(performance.now() - t0);
  }
}
