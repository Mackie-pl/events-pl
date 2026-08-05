/**
 * Wyjście maszynowe źródła → EventItem. Bez LLM, bez sieci — czysta transformacja.
 *
 * Bliźniak `fbEventToItem` z pipeline/facebook.ts i celowo trzyma te same konwencje:
 * `null` gdy brak tytułu albo daty, odrzucenie wydarzeń zakończonych, `""` zamiast `null`
 * w polach czysto tekstowych (budżet 16 pól unijnych, patrz types/event-schema.ts) oraz
 * OTWARTA klasyfikacja wieku i rodzinności — feed jej nie niesie, a zgadywanie tutaj byłoby
 * wymyślaniem danych. Sprawdzone, że to nic nie odfiltrowuje: ageOk() w digest/sections.ts
 * przepuszcza puste `age`, a `family_friendly === true` tylko sortuje i dokleja emoji.
 *
 * Nazwa NIE „structured": `npm run check:structured` dotyczy `response_format` modelu.
 * Tu chodzi o `SourceCapability` — stąd „capability" w nazwie pliku i funkcji.
 *
 * Obsługujemy wyłącznie rodzaje niosące PRAWDZIWY termin wydarzenia. RSS zostaje na ścieżce
 * modelu świadomie: gminny feed „aktualności" ma w `<pubDate>` datę publikacji, a termin
 * imprezy w prozie opisu („…odbędzie się w dniu 05.09.2026") — albo nie ma go wcale.
 */
import { splitDateTime } from "../../shared/dates.js";
import type { AgeRange, EventItem, Price, SourceCapability } from "../../types/index.js";

/** Rodzaje, które umiemy zmapować mechanicznie. Reszta (`rss`, `wp-rest`) idzie do modelu. */
const MAPPABLE = new Set<SourceCapability["kind"]>(["tribe", "ical", "jsonld"]);

export const isMappable = (kind: SourceCapability["kind"]): boolean => MAPPABLE.has(kind);

/**
 * Preferencja przy wielu zdolnościach naraz. `tribe` przed `ical`, bo eksport iCal oddaje
 * zwykle tylko bieżący widok kalendarza: na bracz.edu.pl to 2 wydarzenia wobec 11 z `tribe`.
 */
const PREFERENCE: ReadonlyArray<SourceCapability["kind"]> = ["tribe", "ical", "jsonld"];

/**
 * Eksport POJEDYNCZEGO wydarzenia, nie kalendarz źródła. Wtyczka EventON wystawia przycisk
 * „dodaj do kalendarza" pod `admin-ajax.php?...&event_id=27886&ical=1` — sonda widzi tam
 * `BEGIN:VEVENT` z poprawną datą i zapisuje zdolność, choć adres z definicji odda zawsze
 * to jedno wydarzenie.
 *
 * Dla etapu 2 to pułapka, bo ścieżka maszynowa ZASTĘPUJE skrobanie strony: czerwonak-gok
 * zszedłby z całej listy imprez do jednego „Twórczego Lata". Zdolność bez pokrycia całego
 * źródła nie kwalifikuje się do zastąpienia — wracamy dla niej na stronę i model.
 */
const SINGLE_EVENT_EXPORT = /[?&]event_id=|admin-ajax\.php/i;

/** Najlepsza zdolność nadająca się do mapowania — albo null, gdy źródło żadnej nie ma. */
export function bestCapability(caps: readonly SourceCapability[] = []): SourceCapability | null {
  for (const kind of PREFERENCE) {
    const found = caps.find((c) =>
      c.kind === kind && c.datesParsed > 0 && !SINGLE_EVENT_EXPORT.test(c.url));
    if (found) return found;
  }
  return null;
}

/** Ile rekordów wpadło, ile wyszło i co po drodze odpadło — materiał na ślad decyzyjny. */
export interface CapabilityYield {
  events: EventItem[];
  /** rekordów w wyjściu maszynowym (przed odsiewem) */
  seen: number;
  dropped: { past: number; noDate: number; noTitle: number };
}

const emptyYield = (): CapabilityYield =>
  ({ events: [], seen: 0, dropped: { past: 0, noDate: 0, noTitle: 0 } });

// ---------------- wspólne ----------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  bdquo: "„", rdquo: "”", hellip: "…", oacute: "ó", sbquo: "‚", rsquo: "’", lsquo: "‘",
};

/** Feedy niosą encje HTML nawet w JSON-ie (WordPress) — bez tego tytuły mają „&#x15B;”. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

const clean = (v: unknown): string =>
  typeof v === "string" ? decodeEntities(v).replace(/\s+/g, " ").trim() : "";

const openAge = (): AgeRange => ({ min: null, max: null, label: null });
const openPrice = (): Price => ({ free: null, amount_pln: null, note: null });

/** „Bezpłatne" / „20 zł" / „" → Price. Pusto ≠ za darmo: brak informacji zostaje brakiem. */
function priceOf(raw: string): Price {
  const note = clean(raw);
  if (!note) return openPrice();
  if (/bezp[łl]at|darmow|wst[ęe]p wolny|gratis|free/i.test(note)) {
    return { free: true, amount_pln: null, note };
  }
  const m = /(\d+(?:[.,]\d+)?)/.exec(note);
  const amount = m?.[1] ? Number(m[1].replace(",", ".")) : null;
  return { free: amount === 0 ? true : null, amount_pln: amount, note };
}

/** Nazwa miejsca + adres, ale bez powielania — jak venueOf() w pipeline/facebook.ts. */
function venueOf(name: string, address: string): string {
  if (name && address && !name.includes(address)) return `${name}, ${address}`;
  return name || address;
}

interface Draft {
  title: string;
  start: { date: string | null; time: string | null };
  end: { date: string | null; time: string | null };
  venue: string;
  town: string;
  price: Price;
  tags: string[];
  url: string;
}

/**
 * Draft → EventItem, ze wspólnym odsiewem. Zwraca `null` i podbija właściwy licznik, żeby
 * wywołujący mógł napisać w śladzie, ILE i DLACZEGO odpadło — a nie tylko „wyszło mniej".
 */
function toItem(d: Draft, today: string, dropped: CapabilityYield["dropped"]): EventItem | null {
  if (!d.title) { dropped.noTitle += 1; return null; }
  if (!d.start.date) { dropped.noDate += 1; return null; }
  const lastDay = d.end.date ?? d.start.date;
  if (lastDay < today) { dropped.past += 1; return null; }

  return {
    title: d.title,
    date_start: d.start.date,
    date_end: d.end.date && d.end.date !== d.start.date ? d.end.date : null,
    // kalendarze wypisują każdy termin osobno, więc rytmu nie ma czego opisywać —
    // powtórzenia zwija dopiero foldSeries() po scalaniu duplikatów
    repeat: "",
    time_start: d.start.time,
    time_end: d.end.time,
    venue: d.venue,
    town: d.town,
    price: d.price,
    age: openAge(),
    family_friendly: "maybe",
    tags: d.tags,
    registration: "",
    sub_slots: null,
    conditional: "",
    container: "",
    source_url: d.url,
    is_noise: false, // kalendarz imprez to nie tablica ogłoszeń urzędowych
    geo: null,
  };
}

// ---------------- The Events Calendar (tribe) ----------------

interface TribeVenue { venue?: unknown; address?: unknown; city?: unknown }
interface TribeEvent {
  title?: unknown; start_date?: unknown; end_date?: unknown; url?: unknown; all_day?: unknown;
  cost?: unknown; venue?: TribeVenue; categories?: Array<{ name?: unknown }>;
}

/**
 * Całodniowe wydarzenie w `tribe` ma godziny 00:00:00–23:59:59 — to znacznik, nie termin.
 * Przepisane wprost dałoby w digeście „Kino plenerowe, 00:00", czyli gorzej niż brak godziny.
 * Sprawdzamy też same godziny, bo `all_day` bywa nieustawione przy imporcie z innego kalendarza.
 */
function stripAllDay(
  start: { date: string | null; time: string | null },
  end: { date: string | null; time: string | null },
  allDay: unknown,
): void {
  const looksAllDay = start.time === "00:00" && (end.time === "23:59" || end.time === null);
  if (allDay === true || looksAllDay) {
    start.time = null;
    end.time = null;
  }
}

function fromTribe(body: string, today: string): CapabilityYield {
  const out = emptyYield();
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(body) as { events?: unknown };
  } catch {
    return out; // zepsuty JSON = zero wydarzeń → wywołujący wróci na ścieżkę modelu
  }
  const records = Array.isArray(parsed.events) ? (parsed.events as TribeEvent[]) : [];
  out.seen = records.length;

  for (const rec of records) {
    const cats = (rec.categories ?? []).map((c) => clean(c.name)).filter(Boolean);
    const start = splitDateTime(clean(rec.start_date) || null);
    const end = splitDateTime(clean(rec.end_date) || null);
    stripAllDay(start, end, rec.all_day);
    const item = toItem({
      title: clean(rec.title),
      start,
      end,
      venue: venueOf(clean(rec.venue?.venue), clean(rec.venue?.address)),
      town: clean(rec.venue?.city),
      price: priceOf(clean(rec.cost)),
      tags: cats.length ? cats.map((c) => `tribe:${c.toLowerCase()}`) : ["tribe:wydarzenie"],
      url: clean(rec.url),
    }, today, out.dropped);
    if (item) out.events.push(item);
  }
  return out;
}

// ---------------- iCal ----------------

/** RFC 5545: linia złamana ma kontynuację zaczynającą się spacją/tabem. Sklejamy PRZED parsowaniem. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

const unescapeIcal = (s: string): string =>
  s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();

/**
 * `20260730T180000` (czas ścienny, ew. z TZID) | `20260730T160000Z` (UTC) | `20260730` (cała doba).
 * Sufiks `Z` przeliczamy na Europe/Warsaw — inaczej wieczorny koncert wyszedłby o dwie godziny za wcześnie.
 */
function icalMoment(raw: string): { date: string | null; time: string | null } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(raw.trim());
  if (!m) return { date: null, time: null };
  const [, y, mo, d, hh, mm, , utc] = m;
  const date = `${y}-${mo}-${d}`;
  if (!hh || !mm) return { date, time: null };
  if (!utc) return { date, time: `${hh}:${mm}` };
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(`${date}T${hh}:${mm}:00Z`));
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function fromIcal(body: string, today: string): CapabilityYield {
  const out = emptyYield();
  let cur: Record<string, string> | null = null;

  for (const line of unfold(body)) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur) { out.seen += 1; pushIcal(cur, today, out); }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    // nazwa właściwości to część przed pierwszym ';' (parametry) albo przed ':'
    const name = line.slice(0, colon).split(";")[0]?.toUpperCase() ?? "";
    if (name) cur[name] = line.slice(colon + 1);
  }
  return out;
}

function pushIcal(rec: Record<string, string>, today: string, out: CapabilityYield): void {
  const item = toItem({
    title: unescapeIcal(decodeEntities(rec["SUMMARY"] ?? "")),
    start: icalMoment(rec["DTSTART"] ?? ""),
    end: icalMoment(rec["DTEND"] ?? ""),
    venue: unescapeIcal(decodeEntities(rec["LOCATION"] ?? "")),
    town: "",
    price: openPrice(),
    tags: ["ical:wydarzenie"],
    url: (rec["URL"] ?? "").trim(),
  }, today, out.dropped);
  if (item) out.events.push(item);
}

// ---------------- JSON-LD ----------------

/** Węzły `@type: Event` z bloków ld+json — ten sam obchód, co probeJsonLd w discover/capabilities.ts. */
function eventNodes(html: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n === null || typeof n !== "object") return;
        const node = n as Record<string, unknown>;
        const type = node["@type"];
        const asText = Array.isArray(type) ? type.join(" ") : typeof type === "string" ? type : "";
        if (asText.includes("Event")) found.push(node);
        if (node["@graph"]) walk(node["@graph"]);
      };
      walk(JSON.parse((m[1] ?? "").trim()));
    } catch { /* jeden zepsuty blok nie przekreśla pozostałych */ }
  }
  return found;
}

/** `location` bywa napisem, obiektem Place albo Place z zagnieżdżonym PostalAddress. */
function jsonLdPlace(loc: unknown): { venue: string; town: string } {
  if (typeof loc === "string") return { venue: clean(loc), town: "" };
  if (loc === null || typeof loc !== "object") return { venue: "", town: "" };
  const node = loc as Record<string, unknown>;
  const addr = node["address"];
  if (typeof addr === "string") {
    return { venue: venueOf(clean(node["name"]), clean(addr)), town: "" };
  }
  const a = (addr ?? {}) as Record<string, unknown>;
  const street = [clean(a["streetAddress"]), clean(a["postalCode"]), clean(a["addressLocality"])]
    .filter(Boolean).join(" ");
  return { venue: venueOf(clean(node["name"]), street), town: clean(a["addressLocality"]) };
}

function fromJsonLd(body: string, url: string, today: string): CapabilityYield {
  const out = emptyYield();
  const nodes = eventNodes(body);
  out.seen = nodes.length;

  for (const node of nodes) {
    const offers = (node["offers"] ?? {}) as Record<string, unknown>;
    const place = jsonLdPlace(node["location"]);
    const item = toItem({
      title: clean(node["name"]),
      start: splitDateTime(clean(node["startDate"]) || null),
      end: splitDateTime(clean(node["endDate"]) || null),
      venue: place.venue,
      town: place.town,
      price: priceOf(clean(offers["price"])),
      tags: ["jsonld:wydarzenie"],
      url: clean(node["url"]) || url,
    }, today, out.dropped);
    if (item) out.events.push(item);
  }
  return out;
}

// ---------------- wejście ----------------

/**
 * Treść wyjścia maszynowego → wydarzenia. Nie rzuca: zepsuty feed oddaje pusty plon,
 * a decyzję „wracamy do modelu" podejmuje wywołujący (process-source.ts), bo tylko on
 * wie, czy ma dokąd wrócić.
 */
export function capabilityEvents(
  kind: SourceCapability["kind"], body: string, url: string, today: string,
): CapabilityYield {
  if (kind === "tribe") return fromTribe(body, today);
  if (kind === "ical") return fromIcal(body, today);
  if (kind === "jsonld") return fromJsonLd(body, url, today);
  return emptyYield();
}
