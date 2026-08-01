/**
 * Sonda zdolności: co serwis oddaje maszynowo. Raz, przy discovery — nie codziennie.
 *
 * Pytanie warto zadać, choć odpowiedź zwykle brzmi „nic": na 15 przebadanych serwisów było
 * zero JSON-LD `Event`, zero `<time datetime>` i zero microdanych. Trafiały się za to feedy
 * i wtyczki kalendarzowe, a jeden RSS oszczędza model na zawsze.
 *
 * REGUŁA, BEZ KTÓREJ TA SONDA SZKODZI: liczy się POBRANIE, nie istnienie endpointu.
 * Wszystkie trzy „trafienia" z rozpoznania przeszłyby test „zwraca 200":
 *
 *   zoo.poznan.pl        /wp-json/tribe/events/v1/events  → {"total":0}
 *   kultura.gmina.pl     /wp-json/wp/v2/mec-events        → []
 *   estrada.poznan.pl    /wp-json/wp/v2/event             → 3 wpisy, ale acf:[] — bez dat
 *
 * Stąd `itemsSeen` (były rekordy?) i osobno `datesParsed` (miały datę WYDARZENIA?).
 * Data publikacji wpisu się nie liczy — `date` w WP REST ma każdy post, a wydarzenie
 * bez terminu jest dla nas bezużyteczne.
 */
import { fetchUrl } from "../../adapters/http.js";
import { BROWSER_HEADERS } from "../../adapters/http.js";
import { todayIso } from "../../shared/dates.js";
import { urlKey } from "../../shared/url.js";
import type { SourceCapability } from "../../types/index.js";

/** Klucze, które w WP REST niosą datę PUBLIKACJI — nie mylić z terminem wydarzenia. */
const PUBLISH_KEYS = new Set(["date", "date_gmt", "modified", "modified_gmt"]);
/** Klucze, w których wtyczki kalendarzowe trzymają termin. */
const EVENT_DATE_KEY = /(start|begin|termin|data|event_?date|when|dtstart)/i;

const isDate = (v: unknown): boolean =>
  (typeof v === "string" || typeof v === "number") && !Number.isNaN(new Date(v).getTime())
  && String(v).length >= 6;

/**
 * Termin, który jeszcze NIE minął.
 *
 * Sama obecność daty nie wystarcza i to nie jest teoretyczna ostrożność: `lubon.pl/atom`
 * miał `datesParsed` 100/100, bo gminne „aktualności" pełne są zdań w rodzaju „relacja
 * z 5 lipca". Feed wyglądał na doskonałe wejście maszynowe i nie niósł ani jednego
 * przyszłego wydarzenia. Zdolność ma odpowiadać na pytanie „czy da się stąd wziąć COŚ,
 * co się dopiero odbędzie", więc data przeszła znaczy tyle samo co brak daty.
 */
const isFutureDate = (v: unknown, today = todayIso()): boolean => {
  if (!isDate(v)) return false;
  const d = new Date(v as string | number);
  return d.toISOString().slice(0, 10) >= today;
};

/** Czy w rekordzie (dowolnie zagnieżdżonym) siedzi PRZYSZŁY termin wydarzenia. */
export function hasEventDate(record: unknown, depth = 0, today = todayIso()): boolean {
  if (depth > 3 || record === null || typeof record !== "object") return false;
  return Object.entries(record as Record<string, unknown>).some(([key, value]) => {
    if (PUBLISH_KEYS.has(key)) return false;
    return (EVENT_DATE_KEY.test(key) && isFutureDate(value, today))
      || hasEventDate(value, depth + 1, today);
  });
}

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 15_000);
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 15_000);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

const cap = (
  kind: SourceCapability["kind"], url: string, itemsSeen: number, datesParsed: number,
): SourceCapability => ({ kind, url, itemsSeen, datesParsed, checked: todayIso() });

// ---------------- pojedyncze zdolności ----------------

/** RSS/Atom: adresy z `<link rel=alternate>` plus ścieżki typowe dla polskich CMS-ów gminnych. */
export function feedCandidates(html: string, root: string): string[] {
  const declared = [...html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h): h is string => Boolean(h));
  // 2ClickPortal (komorniki, gokkomorniki, rokietnica) i lokalne warianty nie deklarują wszystkich
  const guessed = [
    "/feed", "/rss.xml", "/aktualnosci.xml",
    "/rss/wydarzenia_pl.xml", "/rss/aktualnosci_pl.xml",
  ];
  // dedupe po urlKey, nie po samym napisie: „/feed" i „/feed/" to jeden feed, a bez tego
  // wchodziły do rejestru dwa razy (i kosztowały dwa pobrania)
  const out = new Map<string, string>();
  for (const href of [...declared, ...guessed]) {
    try {
      const url = new URL(href, root).toString();
      if (!out.has(urlKey(url))) out.set(urlKey(url), url);
    } catch { /* adres nie do rozwinięcia — pomijamy */ }
  }
  return [...out.values()];
}

/**
 * Termin wydarzenia w treści wpisu — „05.09.2026", „5 września", „2026-09-05".
 * Świadomie po TREŚCI, nie po `<pubDate>`: to ostatnie jest datą PUBLIKACJI, czyli dokładnie
 * tym, co reguła tego modułu wyklucza. Liczenie `pubDate` dawało `datesParsed === itemsSeen`
 * dla każdego feedu na świecie — a gminne „aktualności" to w większości nie wydarzenia.
 */
const MONTHS_PL = ["stycz", "lut", "mar", "kwiet", "maj", "czerw",
  "lip", "sierp", "wrze", "paździer", "listopad", "grud"] as const;

const EVENT_DATE_IN_TEXT = new RegExp(
  String.raw`(\d{1,2})[./-](\d{1,2})[./-](\d{4})`         // 05.09.2026
  + String.raw`|(\d{4})-(\d{2})-(\d{2})`                   // 2026-09-05
  + String.raw`|(\d{1,2})\s+(${MONTHS_PL.join("|")})`,     // 5 września
  "gi",
);

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Wszystkie daty z tekstu, w ISO. Zapis bez roku („5 września") czytamy w roku BIEŻĄCYM,
 * a nie w najbliższym przyszłym — inaczej każda relacja z lipca wyglądałaby na zapowiedź
 * na przyszły rok i filtr przyszłości nie odsiewałby niczego. Cena: zapowiedź styczniowa
 * ogłoszona w grudniu wypada jako przeszła. Zaniżenie jest tu bezpieczne — zdolność co
 * najwyżej nie zostanie użyta i źródło pójdzie zwykłą ścieżką przez model.
 */
export function eventDatesInText(text: string, today = todayIso()): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EVENT_DATE_IN_TEXT)) {
    if (m[3]) out.push(`${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`);
    else if (m[4]) out.push(`${m[4]}-${m[5]}-${m[6]}`);
    else if (m[8]) {
      const month = MONTHS_PL.findIndex((p) => m[8]?.toLowerCase().startsWith(p));
      if (month >= 0) out.push(`${today.slice(0, 4)}-${pad(month + 1)}-${pad(Number(m[7]))}`);
    }
  }
  return out;
}

const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const BODY_RE = /<(?:description|summary|content)\b[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i;

/**
 * Czy w treści wpisu (tytuł + opis) widać termin wydarzenia, które się jeszcze NIE odbyło.
 * `<pubDate>` świadomie pomijamy — patrz komentarz przy `isFutureDate`.
 */
export function itemHasEventDate(item: string, today = todayIso()): boolean {
  const parts: string[] = [];
  for (const re of [TITLE_RE, BODY_RE]) {
    const m = re.exec(item);
    if (m?.[1]) parts.push(m[1]);
  }
  const prose = parts.join(" ").replace(/<!\[CDATA\[|\]\]>/g, " ").replace(/<[^>]+>/g, " ");
  return eventDatesInText(prose, today).some((d) => d >= today);
}

async function probeFeed(url: string): Promise<SourceCapability | null> {
  const xml = await getText(url);
  if (!xml || !/<(?:rss|feed)\b/i.test(xml)) return null;
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  if (!items.length) return null;
  // arrow, nie referencja: `filter` podaje indeks jako drugi argument, a tam stoi `today`
  return cap("rss", url, items.length, items.filter((i) => itemHasEventDate(i)).length);
}

/** WordPress REST: typ postu wyglądający na wydarzenia + faktyczne pobranie kolekcji. */
async function probeWpRest(root: string): Promise<SourceCapability | null> {
  const types = await getJson(new URL("/wp-json/wp/v2/types", root).toString());
  if (types === null || typeof types !== "object") return null;
  const entry = Object.entries(types as Record<string, { rest_base?: string }>)
    .find(([key]) => /event|wydarz|mec|tribe|impre/i.test(key));
  const base = entry?.[1]?.rest_base;
  if (!base) return null;
  const url = new URL(`/wp-json/wp/v2/${base}?per_page=5`, root).toString();
  const items = await getJson(url);
  if (!Array.isArray(items)) return null;
  return cap("wp-rest", url, items.length, items.filter((i) => hasEventDate(i)).length);
}

/** The Events Calendar ma własne API z jawnym `start_date` — gdy w ogóle coś zwróci. */
async function probeTribe(root: string): Promise<SourceCapability | null> {
  const url = new URL("/wp-json/tribe/events/v1/events", root).toString();
  const json = await getJson(url);
  const events = (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  return cap("tribe", url, events.length, events.filter((e) => hasEventDate(e)).length);
}

async function probeIcal(entryUrl: string): Promise<SourceCapability | null> {
  const url = new URL(entryUrl);
  url.searchParams.set("ical", "1");
  const text = await getText(url.toString());
  if (!text || !/BEGIN:VCALENDAR/i.test(text)) return null;
  const events = text.match(/BEGIN:VEVENT/gi)?.length ?? 0;
  if (!events) return null;
  return cap("ical", url.toString(), events, text.match(/^DTSTART/gim)?.length ?? 0);
}

/** JSON-LD `@type: Event` — najrzadszy przypadek, ale najtańszy w obsłudze, gdy jest. */
export function probeJsonLd(html: string, url: string): SourceCapability | null {
  const found: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n === null || typeof n !== "object") return;
        const node = n as Record<string, unknown>;
        // @type bywa tablicą ("@type": ["Event","MusicEvent"]) — obie postaci sprowadzamy do napisu
        const type = node["@type"];
        const asText = Array.isArray(type) ? type.join(" ") : typeof type === "string" ? type : "";
        if (asText.includes("Event")) found.push(node);
        if (node["@graph"]) walk(node["@graph"]);
      };
      walk(JSON.parse((m[1] ?? "").trim()));
    } catch { /* jeden zepsuty blok nie przekreśla pozostałych */ }
  }
  if (!found.length) return null;
  return cap("jsonld", url, found.length, found.filter((e) => isDate(e["startDate"])).length);
}

// ---------------- wejście ----------------

/**
 * Wszystkie zdolności serwisu. `entryUrl` to rozpoznany adres listy (jeśli już go znamy) —
 * iCal i JSON-LD mają sens właśnie tam, a nie na stronie głównej.
 */
export async function probeCapabilities(
  root: string, html: string, entryUrl?: string, entryHtml?: string,
): Promise<SourceCapability[]> {
  const out: SourceCapability[] = [];
  const feeds = feedCandidates(html, root);
  for (const url of feeds) {
    const found = await probeFeed(url);
    if (found) out.push(found);
  }
  for (const probe of [probeWpRest(root), probeTribe(root)]) {
    const found = await probe;
    if (found) out.push(found);
  }
  if (entryUrl) {
    const ical = await probeIcal(entryUrl);
    if (ical) out.push(ical);
  }
  const jsonld = probeJsonLd(entryHtml ?? html, entryUrl ?? root);
  if (jsonld) out.push(jsonld);
  // itemsSeen === 0 nie wchodzi do rejestru: „endpoint istnieje, ale nic nie oddaje"
  // to nie zdolność, tylko fałszywy trop dla następnego czytającego
  return out.filter((c) => c.itemsSeen > 0);
}

/** Zdolności nadające się do ekstrakcji — bez dat wydarzeń feed jest tylko ciekawostką. */
export const usableCapabilities = (caps: readonly SourceCapability[]): SourceCapability[] =>
  caps.filter((c) => c.datesParsed > 0);
