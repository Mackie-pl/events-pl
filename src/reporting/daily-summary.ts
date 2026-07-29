/** Podsumowanie przebiegu daily: zakładka Summary w Actions + jedna linia do logu. */
import type { RunReport, SourceRun } from "../types/index.js";

import { costLine } from "./cost-ledger.js";
import { writeSummary } from "./step-summary.js";

const STATUS_ICON: Record<SourceRun["status"], string> = {
  ok: "✅", unchanged: "♻️", error: "⚠️", "skipped-fb": "⏭️", "skipped-dead": "💀", empty: "∅",
};

function headerLines(report: RunReport): string[] {
  const t = report.totals;
  return [
    `## daily-events — ${report.startedAt}`,
    "",
    `**${t.sources}** źródeł · ✅ ${t.ok} ok · ♻️ ${t.unchanged} bez zmian · ` +
    `⚠️ ${t.errors} błędów · ⏭️ ${t.skippedFb} fb · 💀 ${t.skippedDead} martwych · ∅ ${t.empty} pusto · ` +
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
    ...sourceTable(report.sources),
  ]);
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
