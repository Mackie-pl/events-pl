/** Złożenie digestu w trzech formatach: tekst, HTML i wiadomości Telegrama. */
import { seriesLabel } from "../../shared/series.js";
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
  const cycle = seriesLabel(e);
  const warn = e.conditional ? `\n    ⚠️ ${e.conditional}` : "";
  return `  • ${bits.join(" · ")}${cycle ? `\n    🔁 ${cycle}` : ""}${warn}\n    ${e.source_url}`;
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
  const cycle = seriesLabel(e);
  return `<li style="margin-bottom:8px">
    <b>${e.time_start ?? ""}</b> <a href="${e.source_url}">${e.title}</a> ${e.family_friendly === true ? "👨‍👦" : ""}<br>
    <span style="color:#666;font-size:13px">${meta}</span>
    ${cycle ? `<br><span style="color:#3730a3;font-size:13px">🔁 ${cycle}</span>` : ""}
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
  const cycle = seriesLabel(e);
  const rep = cycle ? `\n   🔁 ${esc(cycle)}` : "";
  const warn = e.conditional ? `\n   ⚠️ <i>${esc(e.conditional)}</i>` : "";
  const time = e.time_start ? `<b>${e.time_start}</b> ` : "";
  const fam = e.family_friendly === true ? " 👨‍👦" : "";
  return `• ${time}<a href="${e.source_url}">${esc(e.title)}</a>${fam}\n   <i>${meta}</i>${rep}${warn}`;
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
  /** po jednej wiadomości na sekcję (limit Telegrama: 4096 znaków) */
  tgMessages: string[];
  total: number;
}

/**
 * Jedna sekcja → wiadomości Telegrama. Limit API to 4096 znaków, więc tniemy z zapasem
 * na ~3900 i powtarzamy nagłówek z dopiskiem „(cd.)", żeby każda część dało się czytać osobno.
 */
function telegramChunks(label: string, evs: EventItem[]): string[] {
  const header = `<b>${esc(label)}</b>`;
  const lines = evs.length ? evs.map(lineTg) : ["(nic nie znaleziono)"];
  const out: string[] = [];
  let buf = header;
  for (const ln of lines) {
    if (buf.length + ln.length + 2 > 3900) {
      out.push(buf);
      buf = `${header} <i>(cd.)</i>`;
    }
    buf += `\n\n${ln}`;
  }
  out.push(buf);
  return out;
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
    const items = evs.length ? evs.map(lineHtml).join("") : "<li>(nic nie znaleziono)</li>";
    htmlParts.push(`<h3 style="margin:18px 0 6px">${s.label}</h3>
      <ul style="padding-left:18px;margin:0">${items}</ul>`);
    tgMessages.push(...telegramChunks(s.label, evs));
  }

  const subject = `Wydarzenia: ${sections.map((s) => s.label.split(" (")[0]).join(" + ")} — ${total} pozycji`;
  const ageTxt = childAge !== null ? ` · filtr wieku: ${childAge} lat` : "";
  const ageHtml = childAge !== null ? ` · filtr wieku: ${childAge}` : "";
  const footer = `\n—\nevents-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${ageTxt}`;
  const foot = `events-pl · dane: ${data.generated} · 👨‍👦 = rodzinne${ageHtml}`;
  return {
    subject,
    text: parts.join("\n\n") + footer,
    html: `<div style="font-family:system-ui,sans-serif;max-width:640px">${htmlParts.join("")}
      <p style="color:#999;font-size:12px;margin-top:20px">${foot}</p></div>`,
    tgMessages,
    total,
  };
}
