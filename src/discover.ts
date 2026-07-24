/**
 * Stage 1: discovery źródeł (raz w miesiącu / na nowe miasto).
 * Wejście: miasto + promień (km). Wyjście: sources.json (merge z istniejącym).
 *
 * Drogi krok — mocny model (Sonnet) + API wyszukiwarki. ~2-4 USD na region.
 *
 * Uruchomienie:
 *   ANTHROPIC_API_KEY=... BRAVE_API_KEY=... npm run discover -- "Poznań" 15
 * Brave Search API: darmowy tier 2000 zapytań/mies. Alternatywy: Serper.dev, SearXNG (0 zł).
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchUrl } from "./errors.js";
import { MODEL_DISCOVER, chat } from "./llm.js";
import { DISCOVERY_QUERIES, DISCOVERY_SYSTEM } from "./prompts.js";
import type { SearchResult, Source, SourcesFile } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Gminy w promieniu — Overpass API (OSM, darmowe): admin_level 7/8 wokół miasta. */
async function townsInRadius(centerTown: string, radiusKm: number): Promise<string[]> {
  const q = `
    [out:json][timeout:30];
    area["name"="${centerTown}"]["boundary"="administrative"]->.c;
    ( relation["boundary"="administrative"]["admin_level"~"7|8"](around.c:${radiusKm * 1000}); );
    out tags center;`;
  const res = await fetchUrl("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: new URLSearchParams({ data: q }),
  }, 60_000);
  const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
  const names = new Set<string>([centerTown]);
  for (const el of json.elements ?? []) {
    const name = el.tags?.["name"];
    if (name) names.add(name);
  }
  return [...names].sort();
}

async function webSearch(query: string): Promise<SearchResult[]> {
  const key = process.env["BRAVE_API_KEY"];
  if (!key) throw new Error("Brak BRAVE_API_KEY");
  const res = await fetchUrl(
    `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: "8", country: "pl" })}`,
    { headers: { "X-Subscription-Token": key } },
    20_000,
    "Brave Search",
  );
  const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (json.web?.results ?? []).map((w) => ({
    title: w.title ?? null,
    url: w.url ?? null,
    desc: w.description ?? null,
  }));
}

async function discoverTown(town: string): Promise<Source[]> {
  const results: SearchResult[] = [];
  for (const tmpl of DISCOVERY_QUERIES) {
    results.push(...(await webSearch(tmpl.replace("{town}", town))));
  }
  const out = await chat({
    model: MODEL_DISCOVER,
    system: DISCOVERY_SYSTEM,
    user: `Miasto/gmina: ${town}\nWyniki wyszukiwania:\n${JSON.stringify(results)}`,
    maxTokens: 4000,
  });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]) as { sources?: Source[] }).sources ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const [center = "Poznań", radiusArg = "15"] = process.argv.slice(2);
  const radius = Number.parseInt(radiusArg, 10);
  const towns = await townsInRadius(center, radius);
  console.log(`Gminy w promieniu ${radius} km od ${center}:`, towns.join(", "));

  const path = join(ROOT, "sources.json");
  const cfg: SourcesFile = existsSync(path)
    ? (JSON.parse(await readFile(path, "utf-8")) as SourcesFile)
    : {
        region: {
          name: `${center} +${radius}km`, center: { lat: 0, lon: 0 }, radius_km: radius,
          discovered_at: new Date().toISOString().slice(0, 10), discovery_method: "discover.ts",
        },
        sources: [],
      };
  const known = new Set(cfg.sources.map((s) => s.url.replace(/\/+$/, "")));

  for (const town of towns) {
    for (const s of await discoverTown(town)) {
      const norm = s.url.replace(/\/+$/, "");
      if (known.has(norm) || (s.confidence ?? 0) < 0.5) continue;
      cfg.sources.push({ ...s, verified: false, discovered: "auto" });
      known.add(norm);
      console.log(`  + ${town}: ${s.name} (${s.url})`);
    }
  }

  await writeFile(path, JSON.stringify(cfg, null, 1), "utf-8");
  console.log(`Razem źródeł: ${cfg.sources.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
