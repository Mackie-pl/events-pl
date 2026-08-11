/** Daty: wszystko w formacie YYYY-MM-DD, bo taki jest kontrakt events.json. */

const TZ = "Europe/Warsaw";

/** Dziś wg UTC — używane tam, gdzie porównujemy z datami wydarzeń zapisanymi jako YYYY-MM-DD. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Dziś w strefie PL. Digest wychodzi o 15:00 czasu lokalnego, więc UTC potrafi się rozjechać o dzień. */
export const todayWarsaw = (): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());

/** Data sprzed N dni (UTC) — granica przycinania księgi/przebiegów. */
export const dayOffset = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// Południe UTC jako punkt zaczepienia: chroni przed przeskokiem doby przy zmianie czasu.
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0=nd ... 6=sob */
export const dayOfWeek = (iso: string): number => new Date(`${iso}T12:00:00Z`).getUTCDay();

export const DAY_NAMES = [
  "niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota",
] as const;

/** „27.07" — sama data, bez dnia tygodnia. Używa jej etykieta cyklu, gdzie dzień tygodnia jest już w treści. */
export function fmtShortPl(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** „poniedziałek 27.07" — nagłówek sekcji digestu. */
export function fmtDayPl(iso: string): string {
  return `${DAY_NAMES[dayOfWeek(iso)]} ${fmtShortPl(iso)}`;
}

/**
 * Napis daty → punkt w czasie (ms), albo null.
 *
 * Osobno od `splitDateTime`, bo mierzy co innego. Tamto oddaje DZIEŃ KALENDARZOWY i celowo
 * omija `Date` przy "YYYY-MM-DD", żeby strefa nie przesunęła doby — tu potrzebna jest
 * odległość między dwoma postami z dokładnością do godzin, czyli dokładnie ta precyzja,
 * którą tamto wyrzuca. Zlanie ich w jedno dałoby albo złe daty, albo zerowe rozpiętości.
 */
export function parseInstant(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d{10,13}$/.test(raw)) {
    const ms = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * "2026-07-25T18:00:00Z" | "2026-07-25 18:00" | "1721930400"(unix) → {date, time}.
 * Godzinę emitujemy tylko gdy jest jawnie w napisie (unikamy przesunięć stref przy fallbacku).
 *
 * Tu, a nie w pipeline/facebook.ts, bo mapują tak samo dwa niezależne wejścia maszynowe:
 * rekord Bright Data i rekord `tribe`/JSON-LD. Kopia rozjechałaby się przy pierwszej poprawce.
 */
export function splitDateTime(raw: string | null): { date: string | null; time: string | null } {
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
