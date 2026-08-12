/**
 * Mechanizm podsumowań dla GitHub Actions. Sama TREŚĆ różni się między etapami
 * (inne kolumny), więc wspólny jest tylko zapis i ucieczka znaków w komórkach.
 */
import { appendFileSync } from "node:fs";

import { P } from "../config/index.js";
import { trim } from "../shared/text.js";

/** Komórka tabeli Markdown: bez pionowych kresek i łamania wierszy, przycięta. */
export const md = (s: string, max = 120): string =>
  trim(s.replaceAll("|", "\\|").replace(/\s+/g, " "), max);

/**
 * Czy jest dokąd pisać. Wołają to etapy PRZED zbudowaniem tabel: poza Actions zmiennej nie ma,
 * a składanie kilkuset wierszy Markdowna po to, żeby je wyrzucić, kosztuje bez powodu.
 */
export const summaryEnabled = (): boolean => Boolean(P.GITHUB_STEP_SUMMARY.get());

/** Poza Actions zmiennej nie ma — podsumowanie jest wtedy no-opem, a nie błędem. */
export function writeSummary(lines: string[]): void {
  const path = P.GITHUB_STEP_SUMMARY.get();
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}
