/**
 * Warstwa FB — czysta transformacja (bez sieci):
 *   - wyłuskiwanie i normalizacja linków do wydarzeń FB z dowolnego tekstu,
 *   - mapowanie rekordu Bright Data (Facebook Events) → EventItem,
 *   - spłaszczanie postów z grupy FB do tekstu dla ekstraktora LLM.
 *
 * Nazwy pól Bright Data bywają różne między wersjami scrapera — sięgamy defensywnie
 * po kilka wariantów każdego pola.
 */
import type { BdRecord } from "../adapters/brightdata.js";
import { parseInstant, splitDateTime } from "../shared/dates.js";
import type { AgeRange, EventItem, FbGroupStats, Price } from "../types/index.js";

const EVENT_URL_RE = /(?:https?:\/\/)?(?:[\w-]+\.)?facebook\.com\/events\/(\d+)/gi;

/** Wyłuskaj i znormalizuj linki do wydarzeń FB z tekstu strony/postu. */
export function harvestEventUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EVENT_URL_RE)) {
    const id = m[1];
    if (id) out.add(`https://www.facebook.com/events/${id}`);
  }
  return [...out];
}

export function isEventUrl(url: string): boolean {
  return /facebook\.com\/events\/\d+/i.test(url);
}

/** Pierwsza niepusta wartość spośród kluczy (string lub number). */
function pick(rec: BdRecord, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Wyłuskaj miasto z polskiego adresu ("ul. X 1, 61-000 Poznań" → "Poznań"). */
function townFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  const cleaned = last.replace(/\d{2}-\d{3}/, "").trim();
  return cleaned || null;
}

/**
 * Rekord Bright Data (Facebook Events) → EventItem. Zwraca null gdy brak tytułu/daty
 * albo wydarzenie już się zakończyło (< today). Mapowanie strukturalne — bez LLM (zero dodatkowego kosztu).
 * Klasyfikacja wieku/rodzinności zostaje "otwarta" (age=null, family_friendly="maybe").
 */
/**
 * Miejsce: nazwa + adres, ale bez powielania — scraper często wkleja pełny adres
 * już w nazwę lokalu, a „Dom Kultury, ul. Główna 1, ul. Główna 1" wygląda na błąd danych.
 */
function venueOf(rec: BdRecord): { venue: string | null; town: string | null } {
  const venueName = pick(rec, "location", "venue", "place", "place_name", "location_name");
  const address = pick(rec, "address", "full_address", "location_address");
  const venue = venueName && address && !venueName.includes(address)
    ? `${venueName}, ${address}`
    : venueName ?? address;
  return { venue, town: pick(rec, "city") ?? townFromAddress(address) };
}

export function fbEventToItem(rec: BdRecord, today: string): EventItem | null {
  const title = pick(rec, "name", "title", "event_name");
  const start = splitDateTime(pick(rec, "start_date", "startDate", "date_start", "start_time", "start"));
  if (!title || !start.date) return null;

  const end = splitDateTime(pick(rec, "end_date", "endDate", "date_end", "end_time", "end"));
  const lastDay = end.date ?? start.date;
  if (lastDay < today) return null; // zakończone pomijamy

  const { venue, town } = venueOf(rec);
  const category = pick(rec, "category", "event_type");
  const price: Price = { free: null, amount_pln: null, note: null };
  const age: AgeRange = { min: null, max: null, label: null };

  return {
    title,
    date_start: start.date,
    date_end: end.date && end.date !== start.date ? end.date : null,
    repeat: "", // rekord FB opisuje jeden termin; serie zwija foldSeries()
    time_start: start.time,
    time_end: end.time,
    // "" zamiast null w polach czysto tekstowych — kontrakt schematu, patrz orEmpty()
    // w types/event-schema.ts (budżet 16 pól unijnych u dostawcy)
    venue: venue ?? "",
    town: town ?? "",
    price,
    age,
    family_friendly: "maybe",
    tags: [category ? `fb:${category.toLowerCase()}` : "fb:wydarzenie"],
    registration: pick(rec, "ticket_url", "tickets_url", "external_url", "registration_url") ?? "",
    sub_slots: null,
    conditional: "",
    container: "", // wydarzenie FB jest zawsze samodzielne — nie ma programu do rozbicia
    source_url: pick(rec, "url", "event_url", "input_url", "link") ?? "",
    is_noise: false,
    geo: null,
  };
}

/** Treść postu — ten sam zestaw wariantów, którego używa spłaszczanie do tekstu. */
const postContent = (r: BdRecord): string | null =>
  pick(r, "content", "text", "post_text", "message", "description", "post_content");

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Rytm publikacji grupy, zmierzony na rekordach, za które właśnie zapłaciliśmy.
 *
 * Rozliczenie Bright Data jest per-rekord, a limit na grupę jest dziś jedną stałą wziętą
 * z sufitu — więc wioskowa grupa z jednym postem na tydzień kosztuje tyle samo, co poznańska
 * z dwustoma dziennie, i obie oddają równo `limit` rekordów. Ten pomiar rozróżnia te dwa
 * przypadki i jest wejściem do limitu liczonego osobno dla każdej grupy. Sam limitu NIE
 * rusza — najpierw kilka dni pomiaru, potem decyzja.
 *
 * Rekord bez treści to przy `include_errors=true` raport błędu scrapera (grupa prywatna,
 * usunięta, zmieniony adres), a nie post — płatny tak samo, wart zera. Rozdzielenie
 * `records` od `posts` jest jedynym miejscem, w którym ta różnica w ogóle widać.
 */
export function fbGroupStats(records: BdRecord[], limit: number): FbGroupStats {
  const times: number[] = [];
  let posts = 0;
  let errorRows = 0;
  let blockedWhy: string | null = null;

  for (const r of records) {
    if (postContent(r)) {
      posts += 1;
      const t = parseInstant(pick(r, "date_posted", "date", "timestamp", "created_time", "post_date"));
      if (t !== null) times.push(t);
    } else {
      errorRows += 1;
      blockedWhy ??= pick(r, "error", "warning", "error_code", "warning_code", "message");
    }
  }

  const stats: FbGroupStats = {
    records: records.length,
    posts,
    errorRows,
    limit,
    atLimit: records.length >= limit,
    ...(blockedWhy ? { blockedWhy } : {}),
  };
  if (!times.length) return stats;

  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  stats.newest = isoDay(newest);
  stats.oldest = isoDay(oldest);
  const spanDays = (newest - oldest) / 86_400_000;
  stats.spanDays = Number(spanDays.toFixed(2));
  // okno zerowe (wszystko z jednej chwili) nie daje się podzielić: wiadomo tylko tyle,
  // że tempo jest NIE MNIEJSZE niż `posts` na dobę — a to nie jest pomiar tempa
  if (spanDays > 0) stats.postsPerDay = Number((posts / spanDays).toFixed(1));
  return stats;
}

/**
 * Posty z grupy FB (rekordy Bright Data) → jeden blok tekstu dla ekstraktora LLM.
 * Zachowujemy datę i link postu, żeby model mógł wywnioskować rok i osadzić source_url.
 */
/**
 * Co jeszcze siedzi w opłaconym rekordzie, a czego NIE dostaje model.
 *
 * Spłaszczanie do tekstu bierze wyłącznie treść postu, więc plakat — na którym u wielu
 * ogłoszeń stoi całe „gdzie" — nie istnieje dla potoku. Zmierzone na „W podwodnym świecie"
 * (fb-group-wydarzenia-w-poznaniu-1, 2026-08-12): wydarzenie weszło do digestu z `venue: ""`,
 * bo lokalizacja była tylko na obrazku.
 *
 * To POMIAR, nie naprawa: nazwy pól datasetu Bright Data nie znamy (BdRecord to
 * `Record<string, unknown>`, a archiwum trzyma tekst już po spłaszczeniu), a wstawienie pola
 * o nieznanym znaczeniu do promptu groziłoby wymyślonym miejscem. Najpierw ślad mówi, KTÓRE
 * pole niesie obraz i w ilu postach — dopiero to jest wejściem do decyzji o czytaniu plakatów.
 */
export interface FbPostExtras {
  /** pole z obrazem, pierwsze rozpoznane; null = w żadnym poście nic nie znaleziono */
  imageField: string | null;
  /** ile POSTÓW (nie rekordów) ma choć jeden obraz */
  withImage: number;
  /** pole z miejscem/adresem postu, jeśli scraper takie oddaje */
  placeField: string | null;
  withPlace: number;
  /** jeden URL do obejrzenia w śladzie — czy w ogóle da się go pobrać bez ciasteczek FB */
  sampleImage: string | null;
}

/** Kolejność od najbardziej konkretnego: pierwsze pole z URL-em wygrywa i trafia do śladu. */
const IMAGE_KEYS = [
  "attachments", "photos", "images", "post_image", "post_images",
  "image", "photo", "media", "attachment", "thumbnail",
];

const PLACE_KEYS = ["location", "place", "place_name", "venue", "location_name", "address"];

/**
 * URL-e ukryte w wartości pola. Scrapery oddają obrazy raz jako string, raz jako listę
 * stringów, raz jako listę obiektów `{url}` — a nazwy pól bywają różne między wersjami,
 * więc zgadujemy kształt, nie polegamy na jednym.
 */
function urlsIn(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    const s = value.trim();
    return /^https?:\/\//i.test(s) ? [s] : [];
  }
  if (depth >= 2) return []; // dalej niż listę obiektów nie schodzimy — to już nie jest pole z URL-em
  if (Array.isArray(value)) return value.flatMap((v) => urlsIn(v, depth + 1));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return ["url", "src", "uri", "link", "image", "photo"].flatMap((k) => urlsIn(rec[k], depth + 1));
  }
  return [];
}

export function fbPostExtras(records: BdRecord[]): FbPostExtras {
  const out: FbPostExtras = {
    imageField: null, withImage: 0, placeField: null, withPlace: 0, sampleImage: null,
  };
  for (const r of records) {
    // rekord bez treści to wiersz błędu scrapera, nie post — patrz fbGroupStats
    if (!postContent(r)) continue;
    for (const key of IMAGE_KEYS) {
      const urls = urlsIn(r[key]);
      if (!urls.length) continue;
      out.withImage += 1;
      out.imageField ??= key;
      out.sampleImage ??= urls[0] ?? null;
      break;
    }
    for (const key of PLACE_KEYS) {
      if (!pick(r, key)) continue;
      out.withPlace += 1;
      out.placeField ??= key;
      break;
    }
  }
  return out;
}

export function fbGroupPostsToText(records: BdRecord[]): string {
  const blocks: string[] = [];
  for (const r of records) {
    const content = postContent(r);
    if (!content) continue;
    const date = pick(r, "date_posted", "date", "timestamp", "created_time", "post_date");
    const link = pick(r, "url", "post_url", "link", "post_link");
    blocks.push(
      [date ? `DATA POSTU: ${date}` : null, link ? `LINK: ${link}` : null, content]
        .filter(Boolean).join("\n"),
    );
  }
  return blocks.join("\n\n---\n\n");
}
