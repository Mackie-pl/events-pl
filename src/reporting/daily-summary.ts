/** Podsumowanie przebiegu daily: zakładka Summary w Actions + jedna linia do logu. */
import type { FbValueRow, RunReport, SourceRun } from "../types/index.js";

import { costLine } from "./cost-ledger.js";
import { writeSummary } from "./step-summary.js";

const STATUS_ICON: Record<SourceRun["status"], string> = {
  ok: "✅", unchanged: "♻️", error: "⚠️", "skipped-fb": "⏭️", "skipped-dead": "💀",
  "skipped-inactive": "💤", "skipped-blocked": "🔒", "skipped-costly": "💸", empty: "∅",
};

function headerLines(report: RunReport): string[] {
  const t = report.totals;
  return [
    `## daily-events — ${report.startedAt}`,
    "",
    `**${t.sources}** źródeł · ✅ ${t.ok} ok · ♻️ ${t.unchanged} bez zmian · ` +
    `⚠️ ${t.errors} błędów · ⏭️ ${t.skippedFb} fb · 💀 ${t.skippedDead} martwych · ` +
    // tylko gdy są: zero zablokowanych grup jest stanem normalnym i nie ma o czym meldować
    `${t.skippedBlocked ? `🔒 ${t.skippedBlocked} zablokowanych · ` : ""}` +
    `∅ ${t.empty} pusto · ` +
    `**${t.events}** wydarzeń` +
    `${t.droppedInvalid ? ` (−${t.droppedInvalid} odrzuconych)` : ""} · ` +
    `${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `🔒 ${t.redactedPhones} tel. / ${t.redactedEmails} e-mail zredagowanych · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  ];
}

/**
 * Rozpiska kosztu w summary: „droższy niż zwykle" widać wtedy wprost w logu Actions,
 * bez wchodzenia do panelu.
 */
function costTable(report: RunReport): string[] {
  if (!report.costs?.length) return [];
  const lines = [
    `**Koszt:** ${costLine(report.costs)} · \`~\` = szacunek ze stawki, nie kwota od dostawcy`,
    "",
    "| kategoria | koszt | wolumen | tokeny |",
    "|---|--:|--:|--:|",
  ];
  for (const c of [...report.costs].sort((a, b) => b.usd - a.usd)) {
    const tok = c.tokensIn ? `${c.tokensIn}+${c.tokensOut ?? 0}` : "";
    lines.push(
      `| ${c.category}${c.estimated ? " ~" : ""} | $${c.usd.toFixed(4)} | ` +
      `${c.units} ${c.unit} | ${tok} |`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * Wartość kanału FB: ile płacimy za wydarzenie, którego NIE dała żadna strona.
 *
 * Osobna tabela od kosztów, bo odpowiada na inne pytanie. Tamta mówi „ile wydaliśmy",
 * ta — „czy było za co". Rekordy Bright Data to dziś ~90% rachunku, a bez kolumny `nowe`
 * ich obrona sprowadzała się do „grupy dały 314 wydarzeń", co przy dedupe wobec stron
 * nie znaczy nic.
 */
function fbValueTable(report: RunReport): string[] {
  const rows = report.fbValue;
  if (!rows?.length) return [];
  const VERDICT: Record<string, string> = {
    keep: "✅ zostaje", muted: "💸 wyciszone", "town-floor": "🏘️ podłoga gminy",
    "too-few-runs": "⏳ za mało pobrań", "no-threshold": "— brak progu",
  };
  const lines = [
    "**Wartość kanału FB** (okno `runs.json`) · `nowe` = wydarzenia, których nie dała żadna strona",
    "",
    "| źródło | pobrań | wyd. | nowe | wyłączne | koszt | $/nowe | werdykt |",
    "|---|--:|--:|--:|--:|--:|--:|---|",
  ];
  for (const r of [...rows].sort((a, b) => (b.usdPerNovel ?? Infinity) - (a.usdPerNovel ?? Infinity))) {
    lines.push(
      `| ${r.id} | ${r.fetchedRuns} | ${r.distinct} | ${r.novel} | ${r.exclusive} | ` +
      `$${r.costUsd.toFixed(4)} | ${r.usdPerNovel === undefined ? "—" : `$${r.usdPerNovel.toFixed(4)}`} | ` +
      `${VERDICT[r.verdict] ?? r.verdict} |`,
    );
  }
  lines.push("");
  return lines;
}

function sourceTable(sources: SourceRun[]): string[] {
  const lines = [
    "| źródło | status | http | wyd. | followups | tokeny | ms |",
    "|---|---|--:|--:|:--:|--:|--:|",
  ];
  for (const s of sources) {
    const fu = s.followups.length
      ? `${s.followups.filter((f) => f.outcome !== "error").length}/${s.followups.length}` +
        (s.followupsRechecked ? " ↻" : "")
      : "";
    const tok = s.llm.calls ? `${s.llm.promptTokens}+${s.llm.completionTokens}` : "";
    lines.push(
      `| ${s.id} | ${STATUS_ICON[s.status]} ${s.status} | ${s.httpStatus ?? ""} | ` +
      `${s.events || ""} | ${fu} | ${tok} | ${s.ms || ""} |`,
    );
  }
  lines.push("");
  return lines;
}

/** Tabela statusu do GitHub Actions job summary (Markdown). */
export function writeDailySummary(report: RunReport): void {
  // poza Actions nie ma czego pisać, a budowanie tabel na darmo tylko kosztuje
  if (!process.env["GITHUB_STEP_SUMMARY"]) return;
  writeSummary([
    ...headerLines(report),
    ...costTable(report),
    ...fbValueTable(report),
    ...sourceTable(report.sources),
  ]);
}

/**
 * Jedna linia na stdout — job summary istnieje tylko w Actions, a przebieg lokalny
 * potrzebuje tej samej odpowiedzi: ile kanał FB kosztuje i ile z tego jest naprawdę nowe.
 */
export function fbValueLine(rows: readonly FbValueRow[]): string {
  const cost = rows.reduce((n, r) => n + r.costUsd, 0);
  const novel = rows.reduce((n, r) => n + r.novel, 0);
  const muted = rows.filter((r) => r.verdict === "muted").length;
  const floored = rows.filter((r) => r.verdict === "town-floor").length;
  const waiting = rows.filter((r) => r.verdict === "too-few-runs").length;
  return (
    `FB: $${cost.toFixed(4)} za ${novel} wydarzeń spoza sieci` +
    (novel ? ` ($${(cost / novel).toFixed(4)}/wyd.)` : "") +
    (muted ? ` · ${muted} wyciszonych` : "") +
    (floored ? ` · ${floored} zostaje podłogą gminy` : "") +
    (waiting ? ` · ${waiting} czeka na pomiar` : "")
  );
}

export function summaryLine(r: RunReport): string {
  const t = r.totals;
  return (
    `OK: ${t.events} wydarzeń · ${t.ok} ok / ${t.unchanged} bez zmian / ${t.errors} błędów / ` +
    `${t.skippedFb} fb / ${t.skippedDead} martwych / ${t.empty} pusto · ` +
    `${t.droppedInvalid ? `−${t.droppedInvalid} odrzuconych · ` : ""}${t.calls} LLM · ` +
    `koszt ${costLine(r.costs ?? [])} · ` +
    `PII: −${t.redactedPhones} tel. −${t.redactedEmails} e-mail · ${Math.round(r.durationMs / 1000)}s`
  );
}
