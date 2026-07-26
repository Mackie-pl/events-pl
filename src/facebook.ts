/**
 * Warstwa FB — czysta transformacja (bez sieci):
 *   - wyłuskiwanie i normalizacja linków do wydarzeń FB z dowolnego tekstu,
 *   - mapowanie rekordu Bright Data (Facebook Events) → EventItem,
 *   - spłaszczanie postów z grupy FB do tekstu dla ekstraktora LLM.
 *
 * Nazwy pól Bright Data bywają różne między wersjami scrapera — sięgamy defensywnie
 * po kilka wariantów każdego pola.
 */
import type { BdRecord } from "./brightdata.js";
import type { AgeRange, EventItem, Price } from "./types/index.js";

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

/**
 * "2026-07-25T18:00:00Z" | "2026-07-25 18:00" | "1721930400"(unix) → {date, time}.
 * Godzinę emitujemy tylko gdy jest jawnie w napisie (unikamy przesunięć stref przy fallbacku).
 */
function splitDateTime(raw: string | null): { date: string | null; time: string | null } {
  if (!raw) return { date: null, time: null };
  if (/^\d{10,13}$/.test(raw)) {
    const ms = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? { date: null, time: null } : { date: d.toISOString().slice(0, 10), time: null };
  }
  const m = raw.match(/(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (m) return { date: m[1] ?? null, time: m[2] ?? null };
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? { date: null, time: null } : { date: d.toISOString().slice(0, 10), time: null };
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
export function fbEventToItem(rec: BdRecord, today: string): EventItem | null {
  const title = pick(rec, "name", "title", "event_name");
  const start = splitDateTime(pick(rec, "start_date", "startDate", "date_start", "start_time", "start"));
  if (!title || !start.date) return null;

  const end = splitDateTime(pick(rec, "end_date", "endDate", "date_end", "end_time", "end"));
  const lastDay = end.date ?? start.date;
  if (lastDay < today) return null; // zakończone pomijamy

  const url = pick(rec, "url", "event_url", "input_url", "link") ?? "";
  const venueName = pick(rec, "location", "venue", "place", "place_name", "location_name");
  const address = pick(rec, "address", "full_address", "location_address");
  const town = pick(rec, "city") ?? townFromAddress(address);
  const category = pick(rec, "category", "event_type");
  const ticket = pick(rec, "ticket_url", "tickets_url", "external_url", "registration_url");

  const price: Price = { free: null, amount_pln: null, note: null };
  const age: AgeRange = { min: null, max: null, label: null };
  const venue =
    venueName && address && !venueName.includes(address)
      ? `${venueName}, ${address}`
      : venueName ?? address;

  return {
    title,
    date_start: start.date,
    date_end: end.date && end.date !== start.date ? end.date : null,
    time_start: start.time,
    time_end: end.time,
    venue,
    town,
    price,
    age,
    family_friendly: "maybe",
    tags: [category ? `fb:${category.toLowerCase()}` : "fb:wydarzenie"],
    registration: ticket,
    sub_slots: null,
    conditional: null,
    source_url: url,
    is_noise: false,
    geo: null,
  };
}

/**
 * Posty z grupy FB (rekordy Bright Data) → jeden blok tekstu dla ekstraktora LLM.
 * Zachowujemy datę i link postu, żeby model mógł wywnioskować rok i osadzić source_url.
 */
export function fbGroupPostsToText(records: BdRecord[]): string {
  const blocks: string[] = [];
  for (const r of records) {
    const content = pick(r, "content", "text", "post_text", "message", "description", "post_content");
    if (!content) continue;
    const date = pick(r, "date_posted", "date", "timestamp", "created_time", "post_date");
    const link = pick(r, "url", "post_url", "link", "post_link");
    blocks.push([date ? `DATA POSTU: ${date}` : null, link ? `LINK: ${link}` : null, content].filter(Boolean).join("\n"));
  }
  return blocks.join("\n\n---\n\n");
}
