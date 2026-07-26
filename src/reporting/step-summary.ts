/**
 * Mechanizm podsumowań dla GitHub Actions. Sama TREŚĆ różni się między etapami
 * (inne kolumny), więc wspólny jest tylko zapis i ucieczka znaków w komórkach.
 */
import { appendFileSync } from "node:fs";

import { trim } from "../shared/text.js";

/** Komórka tabeli Markdown: bez pionowych kresek i łamania wierszy, przycięta. */
export const md = (s: string, max = 120): string =>
  trim(s.replaceAll("|", "\\|").replace(/\s+/g, " "), max);

/** Poza Actions zmiennej nie ma — podsumowanie jest wtedy no-opem, a nie błędem. */
export function writeSummary(lines: string[]): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}
