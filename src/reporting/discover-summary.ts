/**
 * Podsumowanie przebiegu discover dla zakładki Summary w GitHub Actions.
 * Jedna funkcja na tabelę — każda odpowiada na inne pytanie, więc i czyta się je osobno.
 */
import type { DiscoverRunReport, SourceVerification, TownDiscoveryRun } from "../types/index.js";

import { costLine } from "./cost-ledger.js";
import { DECISION_ICON, OUTCOME_ICON } from "./icons.js";
import { md, writeSummary } from "./step-summary.js";

/** Nagłówek: co to za przebieg, czy dobiegł końca i jakim kosztem. */
function headerLines(report: DiscoverRunReport): string[] {
  const t = report.totals;
  const lines = [`## discover (${report.mode}) — ${report.startedAt}`, ""];
  if (report.err) {
    lines.push(`> ⚠️ **przebieg przerwany:** ${md(report.err, 300)} — liczby są cząstkowe`, "");
  }
  if (report.geo?.fallback) {
    lines.push(
      `> ⚠️ Overpass padł (${md(report.geo.err ?? "", 200)}) — discovery tylko dla miasta centralnego`,
      "",
    );
  }
  lines.push(
    `**${t.sourcesChecked}** zweryfikowanych · ✅ ${t.ok} ok · 🔧 ${t.fixed} naprawionych · ` +
    `💀 ${t.dead} martwych · ⚠️ ${t.unrepaired} bez próby naprawy · ⏭️ ${t.skipped} pominiętych (FB) · ` +
    `${t.sourcesAdded} nowych (${t.proposalsRejected} propozycji odrzuconych) · ` +
    `${t.searches} zapytań search (${t.searchErrors} błędnych, ${t.searchesSkipped} pominiętych) · ` +
    `${t.calls} LLM (${t.promptTokens}+${t.completionTokens} tok) · ` +
    `koszt ${costLine(report.costs ?? [])} · ` +
    `🔒 ${t.redactedPhones} tel. / ${t.redactedEmails} e-mail zredagowanych · ` +
    `${Math.round(report.durationMs / 1000)}s`,
    "",
  );
  if (!report.archiveEnabled) {
    lines.push(
      "> ℹ️ prywatne archiwum wyłączone (brak SUPABASE_*) — promptów modelu nie da się odtworzyć",
      "",
    );
  }
  return lines;
}

function townTable(towns: TownDiscoveryRun[]): string[] {
  const lines = [
    "| gmina | zapytań | odpowiedź | propozycji | dodanych | tokeny | koszt | ms |",
    "|---|--:|---|--:|--:|--:|--:|--:|",
  ];
  for (const town of towns) {
    // wysłane, nie „zalogowane": pominięte po wyłączeniu wyszukiwarki nie zużyły limitu
    const sent = town.searches.filter((s) => !s.skipped).length;
    const skipped = town.searches.length - sent;
    lines.push(
      `| ${town.town} | ${sent}${skipped ? ` (+${skipped} pom.)` : ""} | ` +
      `${town.parse ?? "—"}${town.err ? ` (${md(town.err, 60)})` : ""} | ` +
      `${town.proposed} | ${town.added} | ${town.llm.promptTokens}+${town.llm.completionTokens} | ` +
      `$${town.llm.costUsd.toFixed(4)} | ${town.ms} |`,
    );
  }
  lines.push("");
  return lines;
}

/** Proweniencja: odpowiedź na „czemu ten adres wszedł na listę" — z odrzuceniami włącznie. */
function proposalTable(towns: TownDiscoveryRun[]): string[] {
  const proposals = towns.flatMap((t) => t.proposals);
  if (!proposals.length) return [];
  const lines = [
    "### Propozycje modelu", "",
    "| decyzja | źródło | URL | conf. | z zapytania | dlaczego / powód odrzucenia |",
    "|---|---|---|--:|---|---|",
  ];
  for (const p of proposals) {
    lines.push(
      `| ${DECISION_ICON[p.decision]} ${p.decision} | ${md(p.name, 40)} | ${md(p.url, 60)} | ` +
      `${p.confidence ?? ""} | ${p.query ? md(p.query, 40) : "—"} | ` +
      `${md([p.why, p.reason].filter(Boolean).join(" · ") || "—", 140)} |`,
    );
  }
  lines.push("");
  return lines;
}

/** Dla świeżo dodanych źródeł `probe` to ich pierwszy fetch w życiu — stąd osobna tabela. */
function freshFetchTable(verifications: SourceVerification[]): string[] {
  const fresh = verifications.filter((v) => v.isNew);
  if (!fresh.length) return [];
  const lines = [
    "### Pierwsze pobranie nowych źródeł", "",
    "| źródło | wynik | http | typ | znaków | przekierowanie | błąd |",
    "|---|---|--:|---|--:|---|---|",
  ];
  for (const v of fresh) {
    lines.push(
      `| ${v.id} | ${OUTCOME_ICON[v.outcome]} ${v.outcome} | ${v.probe?.httpStatus ?? ""} | ` +
      `${v.probe?.contentType ?? ""} | ${v.probe?.chars ?? ""} | ` +
      `${v.probe?.finalUrl ? md(v.probe.finalUrl, 60) : ""} | ` +
      `${md(v.err ?? "", 80)} |`,
    );
  }
  lines.push("");
  return lines;
}

function verificationTable(verifications: SourceVerification[]): string[] {
  const lines = [
    "### Weryfikacja rejestru", "",
    "| źródło | wynik | http | znaków | szczegóły | koszt |",
    "|---|---|--:|--:|---|--:|",
  ];
  for (const v of verifications) {
    const detail = v.outcome === "fixed" ? `→ ${v.newUrl}` : (v.err ?? v.note ?? "");
    const cost = v.llm.costUsd ? `$${v.llm.costUsd.toFixed(4)}` : "";
    lines.push(
      `| ${v.id} | ${OUTCOME_ICON[v.outcome]} ${v.outcome} | ${v.httpStatus ?? ""} | ` +
      `${v.probe?.chars ?? ""} | ${md(detail)} | ${cost} |`,
    );
  }
  lines.push("");
  return lines;
}

export function writeDiscoverSummary(report: DiscoverRunReport): void {
  // poza Actions nie ma czego pisać, a budowanie tabel na darmo tylko kosztuje
  if (!process.env["GITHUB_STEP_SUMMARY"]) return;
  writeSummary([
    ...headerLines(report),
    ...(report.towns.length ? [...townTable(report.towns), ...proposalTable(report.towns)] : []),
    ...freshFetchTable(report.verifications),
    ...verificationTable(report.verifications),
  ]);
}
