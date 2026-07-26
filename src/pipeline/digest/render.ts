/** Złożenie digestu w trzech formatach: tekst, HTML i wiadomości Telegrama. */
import type { EventItem, EventsFile } from "../../types/index.js";

import { pick, sectionsFor } from "./sections.js";

function lineTxt(e: EventItem): string {
  const bits = [
    e.time_start ? `${e.time_start}` : null,
    e.title,
    e.venue ? `@ ${e.venue}` : null,
    e.town ?? null,
    e.age?.label ? `[wiek: ${e.age.label}]` : null,
    e.price.free === true
      ? "[bezpłatne]"
      : e.price.amount_pln
        ? `[${e.price.amount_pln} zł]`
        : null,
    e.family_friendly === true ? "👨‍👦" : null,
  ].filter(Boolean);
  const warn = e.conditional ? `\n    ⚠️ ${e.conditional}` : "";
  return `  • ${bits.join(" · ")}${warn}\n    ${e.source_url}`;
}

function lineHtml(e: EventItem): string {
  const meta = [
    e.venue,
    e.town,
    e.age?.label ? `wiek: ${e.age.label}` : null,
    e.price.free === true
      ? "bezpłatne"
      : e.price.amount_pln
        ? `${e.price.amount_pln} zł`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<li style="margin-bottom:8px">
    <b>${e.time_start ?? ""}</b> <a href="${e.source_url}">${e.title}</a> ${e.family_friendly === true ? "👨‍👦" : ""}<br>
    <span style="color:#666;font-size:13px">${meta}</span>
    ${e.conditional ? `<br><span style="color:#92400e;font-size:13px">⚠️ ${e.conditional}</span>` : ""}
  </li>`;
}

/** Escapowanie dla Telegram parse_mode=HTML. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineTg(e: EventItem): string {
  const meta = [
    e.venue,
    e.town,
    e.age?.label ? `wiek: ${e.age.label}` : null,
    e.price.free === true
      ? "bezpłatne"
      : e.price.amount_pln
        ? `${e.price.amount_pln} zł`
        : null,
  ]
    .filter(Boolean)
    .map((x) => esc(String(x)))
    .join(" · ");
  const warn = e.conditional ? `\n   ⚠️ <i>${esc(e.conditional)}</i>` : "";
  return `• ${e.time_start ? `<b>${e.time_start}</b> ` : ""}<a href="${e.source_url}">${esc(e.title)}</a>${e.family_friendly === true ? " 👨‍👦" : ""}\n   <i>${meta}</i>${warn}`;
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
  /** po jednej wiadomości na sekcję (limit Telegrama: 4096 znaków) */
  tgMessages: string[];
  total: number;
}

export function buildDigest(
  data: EventsFile,
  today: string,
  childAge: number | null,
): Digest {
  const sections = sectionsFor(today);
  const parts: string[] = [];
  const htmlParts: string[] = [];
  const tgMessages: string[] = [];
  let total = 0;

  for (const s of sections) {
    const evs = pick(data.events, s, childAge);
    total += evs.length;
    parts.push(
      `=== ${s.label} ===\n${evs.length ? evs.map(lineTxt).join("\n") : "  (nic nie znaleziono)"}`,
    );
    htmlParts.push(`<h3 style="margin:18px 0 6px">${s.label}</h3>
      <ul style="padding-left:18px;margin:0">${evs.length ? evs.map(lineHtml).join("") : "<li>(nic nie znaleziono)</li>"}</ul>`);
    // Telegram: osobna wiadomość na sekcję; w razie potrzeby tnij co ~3900 znaków
    const header = `<b>${esc(s.label)}</b>`;
    const lines = evs.length ? evs.map(lineTg) : ["(nic nie znaleziono)"];
    let buf = header;
    for (const ln of lines) {
      if (buf.length + ln.length + 2 > 3900) {
        tgMessages.push(buf);
        buf = `${header} <i>(cd.)</i>`;
      }
      buf += `\n\n${ln}`;
    }
    tgMessages.push(buf);
  }

  const subject = `Wydarzenia: ${sections.map((s) => s.label.split(" (")[0]).join(" + ")} — ${total} pozycji`;
  const footer = `\n—\nevents-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${childAge !== null ? ` · filtr wieku: ${childAge} lat` : ""}`;
  return {
    subject,
    text: parts.join("\n\n") + footer,
    html: `<div style="font-family:system-ui,sans-serif;max-width:640px">${htmlParts.join("")}
      <p style="color:#999;font-size:12px;margin-top:20px">events-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${childAge !== null ? ` · filtr wieku: ${childAge}` : ""}</p></div>`,
    tgMessages,
    total,
  };
}
