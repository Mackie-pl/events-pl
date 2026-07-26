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

/** „poniedziałek 27.07" — nagłówek sekcji digestu. */
export function fmtDayPl(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
