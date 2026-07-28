/**
 * Sprawdzenie JEDNEGO źródła na żądanie — z terminala.
 *
 *   npm run probe -- <id>            sprawdź źródło (cache w mocy: niezmieniona strona = zero kosztu)
 *   npm run probe -- <id> --force    pomiń cache — pobierz od nowa i puść przez model (PŁATNE)
 *
 * Nic nie zapisuje: ani events.json, ani state.json, ani raportów (patrz probe-source.ts).
 * Ten sam kod obsługuje przycisk „Check now" w panelu — most (`npm run panel-server`) woła
 * dokładnie tę funkcję, żeby CLI i panel nie mogły się rozjechać.
 *
 * Env: OPENROUTER_API_KEY (przy wywołaniu modelu), BRIGHTDATA_API_KEY (tylko grupy FB).
 */
import { ProbeError, probeSource } from "../pipeline/extract/probe-source.js";
import { describeError } from "../shared/errors.js";
import type { ProbeResult } from "../types/index.js";

/** Jedna linia rachunku: status, ile to kosztowało i czy cache był w grze. */
function headline(r: ProbeResult): string {
  const { run } = r;
  const parts = [
    `status: ${run.status}`,
    run.httpStatus ? `HTTP ${run.httpStatus}` : null,
    run.chars !== undefined ? `${run.chars} znaków` : null,
    `${run.events} wydarzeń`,
    `${run.llm.calls} wywołań LLM`,
    `$${run.llm.costUsd.toFixed(4)}`,
    `${run.ms} ms`,
    r.forced ? "[force]" : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function print(r: ProbeResult): void {
  const { run } = r;
  console.log(`\n${run.name} (${run.id}) · ${run.town} · ${run.url}`);
  console.log(headline(r));
  if (run.err) console.log(`błąd: ${run.err}`);

  console.log("\nślad decyzyjny:");
  for (const s of r.trail.steps) console.log(`  ${String(s.ms).padStart(6)} ms  ${s.step.padEnd(18)} ${s.note}`);

  if (r.events.length) {
    console.log("\nwydarzenia (przed scalaniem duplikatów i redakcją PII):");
    for (const e of r.events) console.log(`  ${e.date_start}  ${e.title}${e.venue ? ` — ${e.venue}` : ""}`);
  }
  if (r.llm.length) {
    console.log(
      `\nwywołania modelu: ${r.llm.length} ` +
      `(prompty i odpowiedzi widać w panelu; tutaj tylko rachunek)`,
    );
  }
  if (!r.forced && run.changed === false) {
    console.log("\nTreść bez zmian — wynik z cache, model nie był wołany. Chcesz naprawdę sprawdzić: --force");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Użycie: npm run probe -- <id-źródła> [--force]");
    process.exit(1);
  }
  print(await probeSource(id, { force }));
}

main().catch((e: unknown) => {
  // ProbeError to odpowiedź dla człowieka („nie ma takiego źródła"), nie awaria — bez stacka
  console.error(e instanceof ProbeError ? e.message : describeError(e));
  process.exit(1);
});
