/** Podsumowanie przebiegu daily: zakładka Summary w Actions + jedna linia do logu. */
import type { RunReport, SourceRun } from "../types/index.js";

import { costLine } from "./cost-ledger.js";
import { writeSummary } from "./step-summary.js";

const STATUS_ICON: Record<SourceRun["status"], string> = {
  ok: "✅", unchanged: "♻️", error: "⚠️", "skipped-fb": "⏭️", "skipped-dead": "💀", empty: "∅",
};

/** Tabela statusu do GitHub Actions job summary (Markdown). */
export function writeDailySummary(report: RunReport): void {
  // poza Actions nie ma czego pisać, a budowanie tabel na darmo tylko kosztuje
  if (!process.env["GITHUB_STEP_SUMMARY"]) return;
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`## daily-events — ${report.startedAt}`, "");
  lines.push(
    `**${t.sources}** źródeł · ✅ ${t.ok} ok · ♻️ ${t.unchanged} bez zmian · ` +
    `⚠️ ${t.errors} błędów · ⏭️ ${t.skippedFb} fb · 💀 ${t.skippedDead} martwych · ∅ ${t.empty} pusto · ` +
    `**${t.events}** wydarzeń · ${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `🔒 ${t.redactedPhones} tel. / ${t.redactedEmails} e-mail zredagowanych · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  if (report.costs?.length) {
    // rozpiska kosztu w summary: „droższy niż zwykle" widać wtedy w logu Actions,
    // bez wchodzenia do panelu
    lines.push(`**Koszt:** ${costLine(report.costs)} · \`~\` = szacunek ze stawki, nie kwota od dostawcy`, "");
    lines.push("| kategoria | koszt | wolumen | tokeny |");
    lines.push("|---|--:|--:|--:|");
    for (const c of [...report.costs].sort((a, b) => b.usd - a.usd)) {
      const tok = c.tokensIn ? `${c.tokensIn}+${c.tokensOut ?? 0}` : "";
      lines.push(`| ${c.category}${c.estimated ? " ~" : ""} | $${c.usd.toFixed(4)} | ${c.units} ${c.unit} | ${tok} |`);
    }
    lines.push("");
  }
  lines.push("| źródło | status | http | wyd. | followups | tokeny | ms |");
  lines.push("|---|---|--:|--:|:--:|--:|--:|");
  for (const s of report.sources) {
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
  writeSummary(lines);
}

export function summaryLine(r: RunReport): string {
  const t = r.totals;
  return (
    `OK: ${t.events} wydarzeń · ${t.ok} ok / ${t.unchanged} bez zmian / ${t.errors} błędów / ` +
    `${t.skippedFb} fb / ${t.skippedDead} martwych / ${t.empty} pusto · ${t.calls} LLM · ` +
    `koszt ${costLine(r.costs ?? [])} · ` +
    `PII: −${t.redactedPhones} tel. −${t.redactedEmails} e-mail · ${Math.round(r.durationMs / 1000)}s`
  );
}
