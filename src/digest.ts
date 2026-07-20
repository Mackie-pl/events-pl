/**
 * Codzienny digest (17:00): JUTRO + najbliższy WEEKEND.
 * Logika dni (czas Europe/Warsaw):
 *   pt  → tylko WEEKEND (sobota + niedziela)
 *   sob → tylko JUTRO (niedziela)
 *   pozostałe (nd–czw) → JUTRO + najbliższy WEEKEND
 *
 * Wysyłka: Resend (darmowy tier 100 maili/dzień, czysty fetch).
 * Env:
 *   RESEND_API_KEY   — brak = dry-run (digest na stdout)
 *   DIGEST_TO        — adres docelowy
 *   DIGEST_FROM      — default: "events-pl <onboarding@resend.dev>"
 *   DIGEST_CHILD_AGE — opcjonalnie: filtruj wg wieku dziecka (np. 5)
 *
 * Uruchomienie: npm run digest
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { EventItem, EventsFile } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "Europe/Warsaw";

// ---------------- daty ----------------

/** Dzisiejsza data YYYY-MM-DD w strefie PL. */
function todayWarsaw(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0=nd ... 6=sob */
function dayOfWeek(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

const DAY_NAMES = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"] as const;

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface Section {
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
    return [{ label: `WEEKEND (${fmtDay(tomorrow)} – ${fmtDay(addDays(today, 2))})`, from: tomorrow, to: addDays(today, 2) }];
  }
  if (dow === 6) {
    // sobota: została tylko niedziela
    return [{ label: `JUTRO (${fmtDay(tomorrow)})`, from: tomorrow, to: tomorrow }];
  }
  // nd–czw: jutro + najbliższy weekend
  const daysToSaturday = (6 - dow + 7) % 7 || 7; // nd→6, pon→5, ... czw→2
  const sat = addDays(today, daysToSaturday);
  const sun = addDays(sat, 1);
  return [
    { label: `JUTRO (${fmtDay(tomorrow)})`, from: tomorrow, to: tomorrow },
    { label: `WEEKEND (${fmtDay(sat)} – ${fmtDay(sun)})`, from: sat, to: sun },
  ];
}

// ---------------- filtrowanie ----------------

function overlaps(ev: EventItem, from: string, to: string): boolean {
  const end = ev.date_end ?? ev.date_start;
  return ev.date_start <= to && end >= from;
}

function ageOk(ev: EventItem, childAge: number | null): boolean {
  if (childAge === null) return true;
  if (ev.age.min !== null && childAge < ev.age.min) return false;
  if (ev.age.max !== null && childAge > ev.age.max) return false;
  return true;
}

function pick(events: EventItem[], s: Section, childAge: number | null): EventItem[] {
  return events
    .filter((e) => !e.is_noise && overlaps(e, s.from, s.to) && ageOk(e, childAge))
    .sort((a, b) => {
      // rodzinne na górę, potem chronologicznie
      const fam = Number(b.family_friendly === true) - Number(a.family_friendly === true);
      return fam || a.date_start.localeCompare(b.date_start) || (a.time_start ?? "").localeCompare(b.time_start ?? "");
    });
}

// ---------------- render ----------------

function lineTxt(e: EventItem): string {
  const bits = [
    e.time_start ? `${e.time_start}` : null,
    e.title,
    e.venue ? `@ ${e.venue}` : null,
    e.town ?? null,
    e.age.label ? `[wiek: ${e.age.label}]` : null,
    e.price.free === true ? "[bezpłatne]" : e.price.amount_pln ? `[${e.price.amount_pln} zł]` : null,
    e.family_friendly === true ? "👨‍👦" : null,
  ].filter(Boolean);
  const warn = e.conditional ? `\n    ⚠️ ${e.conditional}` : "";
  return `  • ${bits.join(" · ")}${warn}\n    ${e.source_url}`;
}

function lineHtml(e: EventItem): string {
  const meta = [
    e.venue, e.town,
    e.age.label ? `wiek: ${e.age.label}` : null,
    e.price.free === true ? "bezpłatne" : e.price.amount_pln ? `${e.price.amount_pln} zł` : null,
  ].filter(Boolean).join(" · ");
  return `<li style="margin-bottom:8px">
    <b>${e.time_start ?? ""}</b> <a href="${e.source_url}">${e.title}</a> ${e.family_friendly === true ? "👨‍👦" : ""}<br>
    <span style="color:#666;font-size:13px">${meta}</span>
    ${e.conditional ? `<br><span style="color:#92400e;font-size:13px">⚠️ ${e.conditional}</span>` : ""}
  </li>`;
}

interface Digest {
  subject: string;
  text: string;
  html: string;
  total: number;
}

export function buildDigest(data: EventsFile, today: string, childAge: number | null): Digest {
  const sections = sectionsFor(today);
  const parts: string[] = [];
  const htmlParts: string[] = [];
  let total = 0;

  for (const s of sections) {
    const evs = pick(data.events, s, childAge);
    total += evs.length;
    parts.push(`=== ${s.label} ===\n${evs.length ? evs.map(lineTxt).join("\n") : "  (nic nie znaleziono)"}`);
    htmlParts.push(`<h3 style="margin:18px 0 6px">${s.label}</h3>
      <ul style="padding-left:18px;margin:0">${evs.length ? evs.map(lineHtml).join("") : "<li>(nic nie znaleziono)</li>"}</ul>`);
  }

  const subject = `Wydarzenia: ${sections.map((s) => s.label.split(" (")[0]).join(" + ")} — ${total} pozycji`;
  const footer = `\n—\nevents-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${childAge !== null ? ` · filtr wieku: ${childAge} lat` : ""}`;
  return {
    subject,
    text: parts.join("\n\n") + footer,
    html: `<div style="font-family:system-ui,sans-serif;max-width:640px">${htmlParts.join("")}
      <p style="color:#999;font-size:12px;margin-top:20px">events-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${childAge !== null ? ` · filtr wieku: ${childAge}` : ""}</p></div>`,
    total,
  };
}

// ---------------- wysyłka ----------------

async function sendResend(d: Digest): Promise<void> {
  const key = process.env["RESEND_API_KEY"];
  const to = process.env["DIGEST_TO"];
  if (!key || !to) {
    console.log("[dry-run] brak RESEND_API_KEY/DIGEST_TO — digest poniżej:\n");
    console.log(`SUBJECT: ${d.subject}\n\n${d.text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env["DIGEST_FROM"] ?? "events-pl <onboarding@resend.dev>",
      to: [to],
      subject: d.subject,
      text: d.text,
      html: d.html,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`Wysłano do ${to}: ${d.subject}`);
}

async function main(): Promise<void> {
  const data = JSON.parse(await readFile(join(ROOT, "events.json"), "utf-8")) as EventsFile;
  const ageEnv = process.env["DIGEST_CHILD_AGE"];
  const childAge = ageEnv ? Number.parseInt(ageEnv, 10) : null;
  const digest = buildDigest(data, todayWarsaw(), Number.isNaN(childAge as number) ? null : childAge);
  await sendResend(digest);
}

// uruchom tylko gdy odpalony bezpośrednio (nie przy imporcie sectionsFor/buildDigest w testach)
if (/digest\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
