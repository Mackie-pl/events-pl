/** Które dni pokrywa dzisiejszy digest i które wydarzenia do nich pasują. */
import { addDays, dayOfWeek, fmtDayPl } from "../../shared/dates.js";
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

function overlaps(ev: EventItem, from: string, to: string): boolean {
  const end = ev.date_end ?? ev.date_start;
  return ev.date_start <= to && end >= from;
}

function ageOk(ev: EventItem, childAge: number | null): boolean {
  if (!ev.age) return true;
  if (childAge === null) return true;
  if (ev.age.min !== null && childAge < ev.age.min) return false;
  if (ev.age.max !== null && childAge > ev.age.max) return false;
  return true;
}

export function pick(
  events: EventItem[],
  s: Section,
  childAge: number | null,
): EventItem[] {
  return events
    .filter(
      (e) => !e.is_noise && overlaps(e, s.from, s.to) && ageOk(e, childAge),
    )
    .sort((a, b) => {
      // rodzinne na górę, potem chronologicznie
      const fam =
        Number(b.family_friendly === true) - Number(a.family_friendly === true);
      return (
        fam ||
        a.date_start.localeCompare(b.date_start) ||
        (a.time_start ?? "").localeCompare(b.time_start ?? "")
      );
    });
}
