/** Wstrzyknięcie danych w template.html → index.html (serwis publikowany na Pages). */
import { readFile, writeFile } from "node:fs/promises";

import { INDEX_HTML, TEMPLATE_HTML } from "../shared/paths.js";
import type { EventsFile, RunReport } from "../types/index.js";

export async function renderHtml(data: EventsFile, report: RunReport): Promise<void> {
  const tpl = await readFile(TEMPLATE_HTML, "utf-8");
  const runView = { startedAt: report.startedAt, totals: report.totals };
  const html = tpl
    .replace("/*__EVENTS__*/", JSON.stringify(data))
    .replace("/*__RUN__*/", JSON.stringify(runView));
  await writeFile(INDEX_HTML, html, "utf-8");
}
