/**
 * Rozbiór argv dla `discover`. Osobny moduł, bo `discover.ts` woła `main()` przy imporcie —
 * testowanie walidacji przez import całej akcji odpalałoby prawdziwy przebieg z siecią,
 * modelem i zapisem rejestru. A walidacja `--reset` jest tym, co MUSI mieć test: pomyłka
 * w tym miejscu kasuje cały rejestr.
 */
export type DiscoverArgs =
  | { mode: "why"; needle: string }
  | { mode: "yield" }
  | { mode: "run"; verifyOnly: boolean; reset: boolean; center: string; radius: number }
  | { mode: "usage"; err: string };

export function parseArgs(args: readonly string[]): DiscoverArgs {
  // tryby raportowe idą PRZED rozbiorem miasta/promienia: czytają zapisany stan, więc
  // domyślne „Poznań 15" nic dla nich nie znaczy i nie ma czego walidować
  if (args.includes("--yield")) return { mode: "yield" };

  const whyAt = args.indexOf("--why");
  if (whyAt !== -1) {
    const needle = args[whyAt + 1];
    return needle
      ? { mode: "why", needle }
      : { mode: "usage", err: 'Użycie: npm run discover -- --why "<id | fragment URL-a | fragment nazwy>"' };
  }
  const [center = "Poznań", radiusArg = "15"] = args.filter((a) => !a.startsWith("--"));
  const radius = Number.parseInt(radiusArg, 10);
  if (!Number.isFinite(radius) || radius <= 0) {
    return { mode: "usage", err: `Promień "${radiusArg}" nie jest dodatnią liczbą km.` };
  }
  const verifyOnly = args.includes("--verify");
  const reset = args.includes("--reset");
  if (reset && verifyOnly) {
    return {
      mode: "usage",
      err: "--reset kasuje rejestr, żeby discovery zbudowało go od nowa — z --verify nie ma czego odtwarzać.",
    };
  }
  return { mode: "run", verifyOnly, reset, center, radius };
}
