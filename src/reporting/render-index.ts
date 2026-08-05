/** Wstrzyknięcie danych w template.html → index.html (serwis publikowany na Pages). */
import { readFile, writeFile } from "node:fs/promises";

import { INDEX_HTML, TEMPLATE_HTML } from "../shared/paths.js";
import { seriesLabel } from "../shared/series.js";
import type { EventsFile, RunReport } from "../types/index.js";

/**
 * Etykieta cyklu doklejana WYŁĄCZNIE do kopii lecącej na stronę — w events.json jej nie ma,
 * bo to zdanie po polsku wyliczone z `dates`, a nie dana o wydarzeniu.
 *
 * Liczona tutaj, a nie w JS-ie szablonu, żeby istniała jedna implementacja: digest i strona
 * mają nazywać ten sam cykl tak samo, a druga kopia reguł „w każdą środę / środy i piątki /
 * terminy: …" rozjechałaby się przy pierwszej poprawce.
 */
function withCycles(data: EventsFile): EventsFile {
  const events = data.events.map((ev) => {
    const cycle = seriesLabel(ev);
    return cycle ? { ...ev, cycle } : ev;
  });
  return { ...data, events };
}

export async function renderHtml(data: EventsFile, report: RunReport): Promise<void> {
  const tpl = await readFile(TEMPLATE_HTML, "utf-8");
  const runView = { startedAt: report.startedAt, totals: report.totals };
  const html = tpl
    .replace("/*__EVENTS__*/", JSON.stringify(withCycles(data)))
    .replace("/*__RUN__*/", JSON.stringify(runView));
  await writeFile(INDEX_HTML, html, "utf-8");
}
