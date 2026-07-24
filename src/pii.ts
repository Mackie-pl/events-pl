/**
 * Redakcja danych osobowych przed publikacją.
 *
 * events.json, index.html i runs.json lądują w PUBLICZNYM repo, a treści stron instytucji
 * zawierają numery kontaktowe osób prowadzących zapisy. Git dodatkowo utrwala je w historii —
 * usunięcie z HEAD nie usuwa ich z repozytorium, więc filtrujemy PRZED zapisem.
 *
 * Zasada (świadomy kompromis użyteczność/prywatność):
 *   - numer STACJONARNY zostaje — to centrala instytucji publicznej, nie osoba,
 *     a bez niego pole "zapisy" traci sens,
 *   - KOMÓRKA i e-mail znikają — zwykle należą do konkretnego pracownika,
 *   - 9-cyfrowy numer o nieznanym prefiksie też znika (fail closed).
 * Użytkownik ma zawsze source_url — instytucja publikuje kontakt u siebie, w kontekście.
 *
 * Pełne, niezredagowane dane zostaną w prywatnym archiwum (Supabase Storage) — nie tutaj.
 */

import type { EventItem } from "./types.js";

/** Prefiksy polskich sieci komórkowych (numer krajowy = 9 cyfr). */
const MOBILE_PREFIXES = new Set([
  "45", "50", "51", "53", "57", "60", "66", "69", "72", "73", "78", "79", "88",
]);

/** Numery kierunkowe stacjonarne (2 cyfry + 7 cyfr abonenta). */
const LANDLINE_AREA_CODES = new Set([
  "12", "13", "14", "15", "16", "17", "18", "22", "23", "24", "25", "29", "32", "33", "34",
  "41", "42", "43", "44", "46", "48", "52", "54", "55", "56", "58", "59", "61", "62", "63",
  "65", "67", "68", "71", "74", "75", "76", "77", "81", "82", "83", "84", "85", "86", "87",
  "89", "91", "94", "95",
]);

export const PHONE_MARK = "[tel. w źródle]";
export const EMAIL_MARK = "[e-mail w źródle]";

// Szeroki łapacz kandydatów — właściwą decyzję podejmuje classifyPhone().
const PHONE_CANDIDATE = /(?:\+?\s?48[\s-]?)?\d(?:[\s.-]?\d){7,10}/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /https?:\/\/\S+/g;

export interface RedactionStats {
  phones: number;
  emails: number;
}

export const newStats = (): RedactionStats => ({ phones: 0, emails: 0 });

type PhoneKind = "mobile" | "landline" | "other";

/** null = to nie jest polski numer telefonu (np. data, cena, identyfikator). */
function classifyPhone(raw: string): PhoneKind | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("0048")) d = d.slice(4);
  else if (d.length === 11 && d.startsWith("48")) d = d.slice(2);
  if (d.length !== 9) return null;
  const prefix = d.slice(0, 2);
  if (MOBILE_PREFIXES.has(prefix)) return "mobile";
  if (LANDLINE_AREA_CODES.has(prefix)) return "landline";
  return "other";
}

function redactSegment(s: string, stats?: RedactionStats): string {
  const noEmails = s.replace(EMAIL, () => {
    if (stats) stats.emails++;
    return EMAIL_MARK;
  });
  return noEmails.replace(PHONE_CANDIDATE, (m) => {
    const kind = classifyPhone(m);
    if (kind === null || kind === "landline") return m;
    if (stats) stats.phones++;
    return PHONE_MARK;
  });
}

/**
 * Usuwa z tekstu komórki i e-maile. URL-e są wycinane z redakcji w całości — numeryczne id
 * w linkach (facebook.com/events/[tel. w źródle]) wyglądają jak komórka, a nią nie są.
 * Tekst dzielimy na fragmenty wokół URL-i, więc nie ma placeholderów ani zmian w białych znakach.
 */
export function redactText(text: string, stats?: RedactionStats): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    parts.push(redactSegment(text.slice(last, m.index), stats), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(redactSegment(text.slice(last), stats));
  return parts.join("");
}

/** Redaguje string, zachowując null/undefined. */
const red = <T extends string | null | undefined>(v: T, stats: RedactionStats): T =>
  (typeof v === "string" ? (redactText(v, stats) as T) : v);

/** Redaguje wolnotekstowe pola wydarzenia w miejscu. Pola strukturalne (daty, geo, URL) nietknięte. */
export function redactEvent(ev: EventItem, stats: RedactionStats): void {
  ev.title = redactText(ev.title, stats);
  ev.registration = red(ev.registration, stats);
  ev.conditional = red(ev.conditional, stats);
  ev.venue = red(ev.venue, stats);
  ev.town = red(ev.town, stats);
  if (ev.container !== undefined) ev.container = redactText(ev.container, stats);
  if (ev.price?.note) ev.price.note = redactText(ev.price.note, stats);
  if (ev.age?.label) ev.age.label = redactText(ev.age.label, stats);
  for (const slot of ev.sub_slots ?? []) {
    slot.label = redactText(slot.label, stats);
    if (slot.age?.label) slot.age.label = redactText(slot.age.label, stats);
  }
}

export function redactEvents(events: EventItem[]): RedactionStats {
  const stats = newStats();
  for (const ev of events) redactEvent(ev, stats);
  return stats;
}
