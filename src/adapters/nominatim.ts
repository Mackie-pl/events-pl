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

/**
 * Człony, które same z siebie nie są miejscem — „Sala kolumnowa", „Start", „Hala".
 * Bez tej listy drabinka pyta o nie pierwsza i dostaje ODPOWIEDŹ: w Poznaniu jest ulica
 * Start i budynek „Hala 2". Fałszywe trafienie jest gorsze niż brak — pinezka ląduje
 * kilometry od wydarzenia i nikt tego nie zauważy, bo `hit=true`.
 */
const GENERIC = new Set([
  "sala", "salka", "aula", "hala", "start", "meta", "zbiórka", "zbiorka", "parking",
  "wejście", "wejscie", "scena", "foyer", "świetlica", "swietlica", "budynek", "miejsce",
]);

/**
 * Odmiana: geokoder zna MIANOWNIK. „na placu Wolności" nie trafia, „plac Wolności" tak.
 * Tylko formy, które realnie wychodzą z prozy o miejscu zbiórki.
 */
const CASES: Record<string, string> = {
  placu: "plac", parku: "park", rynku: "rynek", skwerze: "skwer",
  osiedlu: "osiedle", alei: "aleja", dworcu: "dworzec", moście: "most",
};

/**
 * Wyrazy z małej litery, które ZACZYNAJĄ nazwę miejsca, a nie są prozą przed nią.
 * Bez nich obcinacz prozy zjada „os." z „os. Lecha 43" i „park" z „park Wilsona".
 */
const STARTS = new Set([
  ...Object.keys(CASES), ...Object.values(CASES),
  "ul", "ul.", "ulica", "al", "al.", "aleja", "aleje", "os", "os.", "osiedle",
  "pl", "pl.", "plac", "park", "rynek", "skwer", "bulwar", "las", "lasek",
]);

const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Obcina prozę OTACZAJĄCĄ nazwę: etykietę z przodu, dopowiedzenie i przyimki z tyłu. */
function trimProse(raw: string): string {
  return raw
    .replace(/\s+/g, " ").trim()
    // „Start: przy fontannie…", „Miejsce: …" — etykieta, nie nazwa
    .replace(/^[\p{L} ]{1,15}:\s*/u, "")
    // dopowiedzenie po myślniku: „…Cybisa 4 - garaż", „…12 – wejście od podwórza".
    // Krótkie i z małej litery, żeby nie uciąć nazwy w rodzaju „Poznań - Nowe Miasto".
    .replace(/\s+[-–—]\s+\p{Ll}[^-–—]{0,24}$/u, "")
    // ogon przyimkowy: „Park nad Wartą przy amfiteatrze" → „Park nad Wartą"
    .replace(/\s+(?:przy|koło|obok|naprzeciw(?:ko)?|nieopodal|pod)\s+\p{Ll}.*$/u, "");
}

/**
 * Zdejmuje prozę PRZED nazwą i sprowadza pierwszy wyraz do mianownika:
 * „przy fontannie na placu Wolności" → „plac Wolności".
 */
function trimLead(s: string): string {
  const words = s.split(" ");
  while (words.length > 1) {
    const w = words[0]!.toLowerCase();
    if (/^\p{Lu}/u.test(words[0]!) || STARTS.has(w) || STARTS.has(w.replace(/\./g, ""))) break;
    words.shift();
  }
  const head = words[0]?.toLowerCase();
  return head && head in CASES ? [CASES[head], ...words.slice(1)].join(" ") : words.join(" ");
}

/**
 * Jeden człon `venue` → zapytanie dla geokodera, albo null gdy pytać nie ma o co.
 *
 * Zdejmuje dokładnie te rzeczy, które sprawdzone trafiają w pustkę (patrz geoQueries).
 */
function toQuery(raw: string): string | null {
  let s = trimLead(trimProse(raw));
  // „ul."/„ulica" to JEDYNY prefiks, który psuje Nominatim — „al.", „os.", „pl." działają
  s = s.replace(/^(ul\.|ulica)\s+/i, "");
  // „Park Cytadela w Poznaniu" + doklejone „, Poznań" = miasto dwa razy, i już nie trafia.
  // Miejscowość i tak dokładamy osobno, więc jej wtręt w nazwie jest zbędny.
  s = s.replace(/\s+w\s+\p{Lu}\p{L}+$/u, "");
  s = s.replace(/^[\s.,;–-]+|[\s.,;–-]+$/g, "");
  if (s.length < 3) return null;
  const tokens = s.split(" ");
  // Generyk odrzucamy, gdy człon to TO SŁOWO — ewentualnie z przymiotnikiem, czyli
  // drugim wyrazem z małej litery. „Sala kolumnowa" leci, „Hala Arena" zostaje,
  // bo wielka litera w drugim wyrazie znaczy nazwę własną.
  if (GENERIC.has(norm(tokens[0]!))
    && (tokens.length === 1 || (tokens.length === 2 && !/^\p{Lu}/u.test(tokens[1]!)))) return null;
  return s;
}

/** Kandydat do odpytania. `town` nadpisuje miejscowość wydarzenia, gdy człon niesie własną. */
export interface GeoQuery { q: string; town?: string }

/** Wygląda na nazwę miejscowości: jeden–dwa wyrazy z wielkiej litery. */
const isLocality = (s: string): boolean =>
  /^\p{Lu}[\p{L}-]+(\s\p{Lu}[\p{L}-]+)?$/u.test(s.trim());

/**
 * „Mosina ul. Jana Cybisa 4" → ulica osobno, miejscowość osobno.
 *
 * Źródła gminne piszą adres jednym ciągiem, bez przecinka. Doklejenie do tego `ev.town`
 * daje „Mosina ul. Jana Cybisa 4, Poznań" — dwie miejscowości w jednym zapytaniu i pewne
 * pudło. Gdy przed „ul." stoi coś, co NIE wygląda na nazwę miejscowości („wejście od
 * ul. Mostowej 7"), lewa strona po prostu leci — to proza, nie miejsce.
 */
function splitLocality(part: string): { text: string; town?: string } {
  const m = /^(.*?)\s+(?:ul\.|ulica)\s+(.+)$/iu.exec(part.trim());
  if (!m) return { text: part };
  const [, left, street] = m as unknown as [string, string, string];
  return isLocality(left) ? { text: street, town: left.trim() } : { text: street };
}

/**
 * Warianty zapytania z jednego `venue`, w kolejności prób — pierwszy trafiony wygrywa.
 *
 * Sedno poprawki. `venue` to zlepek „nazwa miejsca, adres" (tak go składa venueOf()),
 * a czasem trzy miejsca naraz albo zdanie. Nominatim w trybie free-form oczekuje JEDNEJ
 * rzeczy plus hierarchii administracyjnej — na zlepku dwóch nazw nie trafia NIC.
 * Sprawdzone na żywym geokoderze (2026-08-14): dziewięć adresów z auditu, które
 * jako całość dawały zero trafień, po rozbiciu na człony trafia komplet.
 *
 * Nazwa miejsca idzie PRZED adresem, bo daje celniejszą pinezkę: „Hipodrom Wola" wskazuje
 * hipodrom, a „Lutycka 34" salon jeździecki pod tym numerem.
 */
export function geoQueries(venue: string): GeoQuery[] {
  const out: GeoQuery[] = [];
  const seen = new Set<string>();
  // nawiasy to zwykle dopowiedzenie („(Ostrów Tumski)") — jako osobny, dalszy człon
  const parts = venue.replace(/[()]/g, ",").split(/[,;]|\s\/\s/);
  for (const p of parts) {
    const { text, town } = splitLocality(p);
    const q = toQuery(text);
    if (!q) continue;
    const dedupe = `${norm(q)}|${town ? norm(town) : ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(town ? { q, town } : { q });
  }
  return out;
}

/** Pola OSM, w których może siedzieć nazwa miejscowości. */
const PLACE_FIELDS = ["city", "town", "village", "municipality", "suburb", "county"] as const;

interface NomHit {
  lat: string; lon: string;
  address?: Partial<Record<(typeof PLACE_FIELDS)[number], string>>;
}

/**
 * Czy trafienie leży w oczekiwanej miejscowości.
 *
 * Drugi filar poprawki: drabinka pyta o krótsze i krótsze człony, więc BEZ tego progu
 * „Wyścigowa 3" trafiłaby w pierwszą lepszą Wyścigową w Polsce. Gdy `town` pusty —
 * przepuszczamy, bo nie ma czego sprawdzić.
 */
function inTown(hit: NomHit, town: string): boolean {
  if (!town) return true;
  const want = norm(town);
  return PLACE_FIELDS.some((f) => {
    const got = hit.address?.[f];
    return got ? norm(got).includes(want) || want.includes(norm(got)) : false;
  });
}

/**
 * Cache per POJEDYNCZE zapytanie, na cały przebieg. Drabinka powtarza te same człony
 * między wydarzeniami („Poznań, plac Wolności" w pięciu miejscach) — bez tego każdy
 * powtórzony człon kosztuje 1,1 s snu wymuszonego polityką Nominatim.
 */
const queryCache = new Map<string, { lat: number; lon: number } | null>();

async function ask(q: string, town: string): Promise<{ lat: number; lon: number } | null> {
  const full = town ? `${q}, ${town}, Poland` : `${q}, Poland`;
  const cached = queryCache.get(full);
  if (cached !== undefined) return cached;
  geoLookups += 1;
  let out: { lat: number; lon: number } | null = null;
  try {
    const res = await fetchUrl(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
        q: full, format: "json", limit: "1", addressdetails: "1", countrycodes: "pl",
      }).toString()}`,
      { headers: UA },
      15_000,
    );
    const hit = ((await res.json()) as NomHit[])[0];
    if (hit && inTown(hit, town)) out = { lat: Number(hit.lat), lon: Number(hit.lon) };
  } catch (e) {
    console.warn(`geocode "${full}": ${describeError(e)}`);
  }
  queryCache.set(full, out);
  await sleep(1_100); // polityka Nominatim
  return out;
}

export async function geocode(
  venue: string, town: string, cache: PipelineState["geo"],
): Promise<{ lat: number; lon: number } | null> {
  const key = `${venue}|${town}`;
  if (key in cache) return cache[key] ?? null;
  let found: { lat: number; lon: number } | null = null;
  for (const cand of geoQueries(venue)) {
    // miejscowość z samego członu ma pierwszeństwo — jest bliżej adresu niż `ev.town`,
    // które bywa miastem źródła, a nie miastem wydarzenia
    found = await ask(cand.q, cand.town ?? town);
    if (found) break;
  }
  cache[key] = found;
  return found;
}
