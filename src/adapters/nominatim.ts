/** Geokoder Nominatim (OSM): darmowy, ale twardo 1 zapytanie/s i banuje za brak User-Agenta. */
import { setTimeout as sleep } from "node:timers/promises";

import { type Bounds, padBounds, pointBounds } from "../shared/bbox.js";
import { describeError } from "../shared/errors.js";
import type { GeoVerdict, PipelineState } from "../types/index.js";

import { fetchUrl } from "./http.js";
import { geoQueries, isLocality, norm } from "./nominatim-query.js";

// Nominatim wymaga UA identyfikującego aplikację (usage policy) — tu zostaje bot.
const UA = { "User-Agent": "LocalEventsBot/0.3 (+kontakt: twoj@email)" };

/** Zapytania do geokodera w tym przebiegu — wolumen do costs.json (kategoria `geo`). */
let geoLookups = 0;

export const geoStats = (): number => geoLookups;
export function resetGeoStats(): void { geoLookups = 0; }

/**
 * PROSTOKĄT REGIONU — obszar, w którym geokoder ma prawo szukać. Ustawiany raz na przebieg.
 *
 * Do 2026-08-21 pytaliśmy z samym `countrycodes=pl`, czyli o CAŁĄ Polskę, i to była cicha
 * usterka, bo wyglądała jak sukces. Drabinka schodzi do coraz krótszych członów, więc na
 * „Świetlica Wiejska w Borkowicach" OSM odpowiadał Bolesławcem spod Wrocławia — `hit=true`,
 * pinezka 283 km od wydarzenia, nikt tego nie ogląda. W events.json z 2026-08-21 tak stało
 * 11 z 204 zgeokodowanych wpisów, cztery z nich to miejsca całkowicie miejscowe.
 *
 * SKĄD PROSTOKĄT: najlepiej z discovery (`sources.json` → `region.bounds`), bo to obszar,
 * który realnie przeszukaliśmy. Sam `center` + `radius_km` opisuje KOŁO OD PUNKTU, a promień
 * liczy się od GRANIC miasta centralnego — Poznań ma 24 km w poprzek, więc prostokąt z punktu
 * wypycha poza region Mosinę, Dopiewo i Borkowice (zmierzone 2026-08-21: 26 z 215 par
 * „venue|town" dostawało fałszywe „poza regionem"). Dlatego bez danych z discovery dokładamy
 * margines: prostokąt ma być HOJNY, bo za ciasny kasuje pinezki po cichu, a od precyzyjnego
 * dopasowania miejscowości jest `inTown()` i osobne pytanie w `probeWhere`.
 */
let region: { box: Bounds; view: string } | null = null;

/**
 * Margines dla prostokąta pinezki, gdy nie znamy zasięgu z discovery. Rząd wielkości
 * rozciągłości dużego miasta — tyle właśnie gubi liczenie promienia od punktu zamiast
 * od granic. Kosztuje najwyżej to, że imiennik 30 km stąd przejdzie przez `bounded`
 * (i wpadnie w `inTown()`); brak marginesu kosztuje pinezki wszystkich okolicznych gmin.
 */
const BOX_MARGIN_KM = 25;

/** Prostokąt w formacie viewboksu Nominatim: lewo,góra,prawo,dół (lon/lat). */
const viewbox = (b: Bounds): string =>
  [b.minlon, b.maxlat, b.maxlon, b.minlat].map((n) => n.toFixed(5)).join(",");

/**
 * Region na ten przebieg + UNIEWAŻNIENIE CACHE'U, gdy prostokąt się zmienił.
 *
 * Wpisy w `state.geo` są odpowiedziami na pytanie zadane w JAKIMŚ prostokącie — po zmianie
 * zasięgu (inny `center`, inny `radius_km`) opisują już inny świat, a Bolesławiec spod
 * Wrocławia siedziałby w nich do końca świata, bo klucz „venue|town" się nie zmienia.
 * Geokoder jest darmowy, więc odbudowa kosztuje wyłącznie czas przebiegu — dlatego czyścimy
 * cały cache, zamiast wymyślać, które wpisy przetrwają. Stempel leży w state.json, więc
 * mechanizm zadziała także za rok, gdy nikt nie będzie pamiętał, że coś takiego tu jest.
 */
export function setGeoRegion(
  r: { center: { lat: number; lon: number }; radius_km: number; bounds?: Bounds },
  state: PipelineState,
): void {
  const box = r.bounds
    // prostokąt z discovery jest już rozszerzony o promień — dokładanie drugi raz zawyżałoby zasięg
    ?? padBounds(pointBounds(r.center), r.radius_km + BOX_MARGIN_KM);
  const view = viewbox(box);
  region = { box, view };
  if (state.geoRegion === view) return;
  const stale = Object.keys(state.geo).length;
  state.geo = {};
  state.geoRegion = view;
  if (stale) {
    console.log(`  region geokodera: ${view} — ${stale} wpisów cache'u pytanych o inny ` +
      "obszar wyrzuconych, odbudują się w tym przebiegu");
  }
}

/** Pola OSM, w których może siedzieć nazwa miejscowości. */
const PLACE_FIELDS = ["city", "town", "village", "municipality", "suburb", "county"] as const;

interface NomHit {
  lat: string; lon: string;
  display_name?: string;
  address?: Partial<Record<(typeof PLACE_FIELDS)[number] | "country" | "country_code", string>>;
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

const UNKNOWN: GeoVerdict = { pin: null, where: "unknown" };

/**
 * Cache per POJEDYNCZE zapytanie, na cały przebieg. Drabinka powtarza te same człony
 * między wydarzeniami („Poznań, plac Wolności" w pięciu miejscach) — bez tego każdy
 * powtórzony człon kosztuje 1,1 s snu wymuszonego polityką Nominatim.
 */
const queryCache = new Map<string, NomHit | null>();

/** Jedno pytanie do Nominatim. `params` decydują, czy pytamy o region, czy o cały świat. */
async function nominatim(full: string, params: Record<string, string>): Promise<NomHit | null> {
  // klucz z PEŁNYM zestawem parametrów: to samo `q` zadane w prostokącie, w Polsce i na
  // świecie to trzy różne pytania, a wspólny klucz cicho podstawiłby odpowiedź na inne
  const key = `${full}|${new URLSearchParams(params).toString()}`;
  const cached = queryCache.get(key);
  if (cached !== undefined) return cached;
  geoLookups += 1;
  let out: NomHit | null = null;
  try {
    const res = await fetchUrl(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
        q: full, format: "json", limit: "1", addressdetails: "1", ...params,
      }).toString()}`,
      { headers: UA },
      15_000,
    );
    out = ((await res.json()) as NomHit[])[0] ?? null;
  } catch (e) {
    console.warn(`geocode "${full}": ${describeError(e)}`);
  }
  queryCache.set(key, out);
  await sleep(1_100); // polityka Nominatim
  return out;
}

/** Pytanie o pinezkę — ograniczone do prostokąta regionu, gdy go znamy. */
async function ask(q: string, town: string): Promise<{ lat: number; lon: number } | null> {
  const full = town ? `${q}, ${town}, Poland` : `${q}, Poland`;
  const hit = await nominatim(full, region
    ? { countrycodes: "pl", viewbox: region.view, bounded: "1" }
    : { countrycodes: "pl" });
  return hit && inTown(hit, town) ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

/**
 * Werdykt dla miejscowości, której nie ma w prostokącie — nazwanie kraju, nie decyzja.
 * Brak kodu kraju czytamy jako „nie wiemy" i nic nie kasujemy (fail closed).
 */
function abroadVerdict(hit: NomHit, town: string): GeoVerdict {
  const country = hit.address?.country_code?.toLowerCase();
  if (!country || country === "pl") return UNKNOWN;
  return { pin: null, where: "abroad", place: hit.address?.country ?? town };
}

/**
 * `featureType=settlement` — pytamy o MIEJSCOWOŚĆ, nie o cokolwiek o tej nazwie.
 *
 * Bez tego prostokąt przepuszczał „Maroko" (sklep w Suchym Lesie), „Peru" (konsulat honorowy
 * przy Głogowskiej) i „Madera" (przysiółek pod Neklą) — trzy wycieczki biura podróży uznane
 * za miejscowe, bo ktoś tak nazwał lokal. Zmierzone 2026-08-21: filtr podniósł rozdzielenie
 * z 15/19 do 21/23 destynacji poza regionem, nie tracąc ANI JEDNEJ z 30 naszych wsi.
 */
const SETTLEMENT = { countrycodes: "pl", featureType: "settlement" };

/**
 * Gdzie leży miejscowość — pytanie zadawane WYŁĄCZNIE wtedy, gdy adres nie dał pinezki.
 *
 * Kolejność pytań jest tu całą treścią mechanizmu:
 *   1. czy ta miejscowość istnieje W NASZYM PROSTOKĄCIE. To jedyne pytanie, które odróżnia
 *      wieś Nowinki w gminie Mosina od Nowinek pod Piasecznem, Borkowice pod Mosiną od
 *      Borkowic pod Koszalinem, a wieś Szkocja w gminie Szubin od Szkocji. Zmierzone
 *      2026-08-21 na events.json: 30 z 31 naszych miejscowości znajduje się w prostokącie,
 *      21 z 23 destynacji wyjazdowych — nie.
 *   2. dopiero gdy jej u nas nie ma, pytamy GDZIE jest. To już tylko opis do śladu:
 *      „Turcja, gmina Sanniki" i „Türkiye" znaczą dla nas dokładnie to samo — nie u nas.
 *
 * Czego to pytanie NIE robi: nie sięga po człony `venue`. „Sala Fitness OSiR" puszczone na
 * świat trafi w cokolwiek, a fałszywe „nie nasze" kasuje prawdziwe wydarzenie po cichu.
 * Bez znanego regionu nie orzekamy nic — nie ma z czym porównać.
 */
async function probeWhere(town: string): Promise<GeoVerdict> {
  if (!region || !town || !isLocality(town)) return UNKNOWN;
  const here = await nominatim(`${town}, Poland`,
    { ...SETTLEMENT, viewbox: region.view, bounded: "1" });
  // miejscowość jest nasza — adresu OSM nie zna, ale to najczęstszy i niegroźny przypadek
  if (here) return { pin: null, where: "region" };
  const polish = await nominatim(`${town}, Poland`, SETTLEMENT);
  if (polish) return { pin: null, where: "far", place: polish.display_name ?? town };
  const world = await nominatim(town, {});
  return world ? abroadVerdict(world, town) : UNKNOWN;
}

/**
 * Werdykt dla jednego wydarzenia. `venue` puste jest teraz PRAWIDŁOWYM wejściem: post
 * z plakatu bywa bez adresu, a samo „Turcja" w `town` to komplet informacji, jakiego
 * potrzeba, żeby stwierdzić, że to nie jest wydarzenie z naszego regionu.
 */
export async function geocode(
  venue: string, town: string, cache: PipelineState["geo"],
): Promise<GeoVerdict> {
  const key = `${venue}|${town}`;
  const hit = cache[key];
  if (hit) return hit;
  for (const cand of geoQueries(venue, town)) {
    // miejscowość z samego członu ma pierwszeństwo — jest bliżej adresu niż `ev.town`,
    // które bywa miastem źródła, a nie miastem wydarzenia
    const pin = await ask(cand.q, cand.town ?? town);
    if (pin) return (cache[key] = { pin, where: "region" });
  }
  return (cache[key] = await probeWhere(town));
}
