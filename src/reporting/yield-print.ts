/**
 * Wydruk raportu plonu. Osobno od `source-yield.ts`, bo tamten liczy i da się go testować
 * bez łapania `console` — tu mieszka wyłącznie formatowanie.
 */
import type { SourcesFile } from "../types/index.js";

import type { SourceYield, YieldReport } from "./source-yield.js";

const usd = (n: number): string => `$${n.toFixed(4)}`;
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const num = (n: number | string, w: number): string => String(n).padStart(w);

/** Jedna linia tabeli plonu. `—` przy koszcie na wyłączne wydarzenie: źródło nic nie dało. */
function row(s: SourceYield): string {
  const perExclusive = s.exclusive ? usd(s.costUsd / s.exclusive) : "—";
  return `  ${pad(s.id, 32)} ${num(s.runs, 5)} ${num(s.produced, 8)} ${num(s.distinct, 7)} ` +
    `${num(s.exclusive, 9)} ${num(s.shared, 8)} ${num(usd(s.costUsd), 10)} ${num(perExclusive, 11)}`;
}

/** Tabela pokazuje wyłącznie źródła, które cokolwiek dały — jałowe mają własną sekcję. */
function printTable(report: YieldReport): void {
  const active = report.sources.filter((s) => s.distinct > 0);
  console.log(
    `\n  ${pad("źródło", 32)} ${num("przeb.", 5)} ${num("wydarz.", 8)} ${num("różnych", 7)} ` +
    `${num("WYŁĄCZNE", 9)} ${num("wspólne", 8)} ${num("koszt", 10)} ${num("$/wyłączne", 11)}`,
  );
  console.log("  " + "─".repeat(94));
  for (const s of active) console.log(row(s));
  console.log(`  (${report.sources.length - active.length} źródeł bez ani jednego wydarzenia — niżej)`);
}

/** Pary źródeł, które trzymają to samo — tu zapada decyzja „które z dwóch". */
function printOverlaps(report: YieldReport): void {
  const pairs = report.sources
    .filter((s) => s.shared > 0 && s.overlaps.length)
    .map((s) => ({ s, top: s.overlaps[0]! }))
    .sort((a, b) => b.top.keys - a.top.keys)
    .slice(0, 12);
  if (!pairs.length) return;
  console.log("\n═══ największe nakładki (z kim źródło dzieli najwięcej wydarzeń)");
  for (const { s, top } of pairs) {
    const rest = s.overlaps.length > 1 ? ` (+${s.overlaps.length - 1} innych)` : "";
    console.log(`  ${pad(s.id, 32)} ${num(top.keys, 4)} wspólnych z ${top.id}${rest}`);
  }
}

const sum = (steps: YieldReport["steps"]): number => steps.reduce((n, s) => n + s.costUsd, 0);

/**
 * Symulacja. Kolejność MA znaczenie i dlatego jest wypisana: zdejmujemy od najdroższego,
 * a każde zdjęcie zmienia sytuację następnych — dwa źródła z tym samym wydarzeniem są
 * zbędne pojedynczo, ale nie razem.
 *
 * Jałowe i redundantne są rozdzielone, bo mieszanie ich jest mylące w konkretną stronę:
 * lista „można zdjąć" wypełnia się wtedy zepsutymi źródłami i wygląda, jakby rejestr był
 * pełen duplikatów, podczas gdy duplikaty mogą w nim nie odpowiadać za ani jedną pozycję.
 */
function printSimulation(report: YieldReport): void {
  const redundant = report.steps.filter((s) => s.reason === "redundant");
  const barren = report.steps.filter((s) => s.reason === "barren");
  const kept = report.steps.filter((s) => !s.dropped);

  console.log("\n═══ redundantne: dają wydarzenia, ale wszystkie ma ktoś inny");
  if (redundant.length) {
    for (const s of redundant) console.log(`  💸 ${pad(s.id, 32)} ${num(usd(s.costUsd), 10)}`);
    console.log(`  razem ${redundant.length} źródeł · ${usd(sum(redundant))} na przebieg`);
  } else {
    console.log("  Żadnego. Nakładanie istnieje, ale każde źródło ma coś wyłącznie swojego —");
    console.log("  usunięcie któregokolwiek kosztowałoby wydarzenia, nie tylko duplikaty.");
  }

  const paid = barren.filter((s) => s.costUsd > 0);
  const free = barren.length - paid.length;
  console.log("\n═══ jałowe: zero wydarzeń w całym oknie (to zwykle usterka, nie nadmiar)");
  for (const s of paid) {
    console.log(`  🕳️ ${pad(s.id, 32)} ${num(usd(s.costUsd), 10)} · status: ${s.status}`);
  }
  if (free) console.log(`  … oraz ${free} źródeł jałowych za darmo (pomijane albo martwe)`);
  console.log(`  razem ${barren.length} źródeł · ${usd(sum(paid))} na przebieg`);

  // celowo NIE „do zdjęcia 25 źródeł": jałowe zwykle trzeba naprawić, a nie usunąć,
  // i zsumowanie ich z redundantnymi w jedną liczbę doradzałoby dokładnie odwrotnie
  console.log(
    `\n  BILANS: ${kept.length} źródeł zarabia na siebie · ` +
    `${redundant.length} redundantnych (${usd(sum(redundant))}) · ` +
    `${barren.length} jałowych (${usd(sum(paid))})`,
  );
  if (!redundant.length && paid.length) {
    console.log("  Nadmiar w rejestrze nie kosztuje NIC — cały wydatek bez pokrycia to źródła,");
    console.log("  które nic nie dają. To zgłoszenie usterek, nie lista do skasowania.");
  }
}

/** Źródła z rejestru, o których okno nic nie mówi — brak danych to nie zerowy plon. */
function printUnmeasured(report: YieldReport, cfg: SourcesFile): void {
  const measured = new Set(report.sources.map((s) => s.id));
  const missing = cfg.sources.filter((s) => !measured.has(s.id));
  if (!missing.length) return;
  console.log(`\n═══ w rejestrze, ale bez danych w oknie (${missing.length})`);
  console.log("  Nie znaczy \"zero plonu\" — znaczy \"daily jeszcze ich nie widziało\".");
  console.log(`  ${missing.map((s) => s.id).join(", ")}`);
}

export function printYield(report: YieldReport, cfg: SourcesFile): void {
  console.log(`═══ plon źródeł — ${report.runs} przebiegów (${report.from} … ${report.to})`);
  console.log(`  różnych wydarzeń w oknie: ${report.distinctEvents}`);
  if (report.skippedRuns.length) {
    console.log(`  pominięte przebiegi sprzed śledzenia przypisań: ${report.skippedRuns.join(", ")}`);
  }
  if (!report.runs) {
    console.log("\n  Brak przebiegów z przypisaniem wydarzeń do źródeł — najpierw `npm run daily`.");
    return;
  }

  printTable(report);
  printOverlaps(report);
  printSimulation(report);
  printUnmeasured(report, cfg);

  console.log(
    "\n  Zastrzeżenia: \"wyłączne\" znaczy \"w TYM oknie nikt inny tego nie dał\" — utraty\n" +
    "  wyprzedzenia (kto opublikował pierwszy) ten rachunek nie mierzy. Tożsamość wydarzenia\n" +
    "  to shared/event-key.ts: tytuł bez znaków specjalnych, obcięty do 40 znaków, + data —\n" +
    "  rozjeżdża się na \"Fiesta\" vs \"Fiesta 2026\", więc NAKŁADANIE JEST ZANIŻONE, a wyłączność\n" +
    "  zawyżona. Źródło, które i tak wyszło na zbędne, jest zbędne tym pewniej.",
  );
}
