/** Które dni pokrywa dzisiejszy digest i które wydarzenia do nich pasują. */
import { addDays, dayOfWeek, fmtDayPl } from "../../shared/dates.js";
import { occursIn } from "../../shared/series.js";
import type { EventItem } from "../../types/index.js";

export interface Section {
  label: string;
  from: string;
  to: string;
}

/** Sekcje digestu wg dnia tygodnia. */
export function sectionsFor(today: string): Section[] {
  const dow = dayOfWeek(today);
  const tomorrow = addDays(today, 1);
  if (dow === 5) {
    // piątek: jutro==sobota, więc jedna sekcja weekendowa
    return [
      {
        label: `WEEKEND (${fmtDayPl(tomorrow)} – ${fmtDayPl(addDays(today, 2))})`,
        from: tomorrow,
        to: addDays(today, 2),
      },
    ];
  }
  if (dow === 6) {
    // sobota: została tylko niedziela
    return [
      { label: `JUTRO (${fmtDayPl(tomorrow)})`, from: tomorrow, to: tomorrow },
    ];
  }
  // nd–czw: jutro + najbliższy weekend
  const daysToSaturday = (6 - dow + 7) % 7 || 7; // nd→6, pon→5, ... czw→2
  const sat = addDays(today, daysToSaturday);
  const sun = addDays(sat, 1);
  return [
    { label: `JUTRO (${fmtDayPl(tomorrow)})`, from: tomorrow, to: tomorrow },
    { label: `WEEKEND (${fmtDayPl(sat)} – ${fmtDayPl(sun)})`, from: sat, to: sun },
  ];
}

// ---------------- filtrowanie ----------------

function ageOk(ev: EventItem, childAge: number | null): boolean {
  if (!ev.age) return true;
  if (childAge === null) return true;
  if (ev.age.min !== null && childAge < ev.age.min) return false;
  if (ev.age.max !== null && childAge > ev.age.max) return false;
  return true;
}

/**
 * Pierwszy termin wydarzenia widoczny w tej sekcji.
 *
 * Sortowanie idzie po NIM, a nie po `date_start`: seria zaczęta w czerwcu wisiałaby inaczej
 * na górze każdej listy do końca sezonu. Renderowi ta sama data mówi, którą sobotę właściwie
 * pokazuje.
 */
export const dateIn = (ev: EventItem, s: Section): string =>
  occursIn(ev, s.from, s.to)[0] ?? ev.date_start;

export function pick(
  events: EventItem[],
  s: Section,
  childAge: number | null,
): EventItem[] {
  return events
    .filter(
      (e) => !e.is_noise && occursIn(e, s.from, s.to).length > 0 && ageOk(e, childAge),
    )
    .sort((a, b) => {
      // rodzinne na górę, potem chronologicznie
      const fam =
        Number(b.family_friendly === true) - Number(a.family_friendly === true);
      return (
        fam ||
        dateIn(a, s).localeCompare(dateIn(b, s)) ||
        (a.time_start ?? "").localeCompare(b.time_start ?? "")
      );
    });
}
