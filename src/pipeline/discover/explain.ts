/**
 * Tryb --why: dlaczego ten adres jest (albo go nie ma) w rejestrze.
 * Czyta wyłącznie zapisany stan — żadnej sieci, żadnych kosztów.
 *
 * fmtProbe celowo dubluje się z panel/src/app/format.ts: tam jest inny format wyjścia
 * (panel, angielskie etykiety) i inny odbiorca, a oba projekty to osobne instalacje npm.
 */
import { DECISION_ICON, OUTCOME_ICON } from "../../reporting/icons.js";
import type { DiscoverRunReport, FetchProbe, Source, SourcesFile } from "../../types/index.js";

const fmtProbe = (p: FetchProbe): string =>
  `${p.ok ? "OK" : "PADŁ"} · HTTP ${p.httpStatus ?? "—"} · ${p.contentType ?? "?"} · ` +
  `${p.chars ?? "?"} zn. · ${p.ms} ms${p.finalUrl ? ` · przekierowanie → ${p.finalUrl}` : ""}` +
  `${p.err ? ` · ${p.err}` : ""}`;

function printProvenance(src: Source): void {
  const p = src.provenance;
  if (!p) {
    console.log("  proweniencja: BRAK — źródło dodane ręcznie albo przed wprowadzeniem śledzenia.");
    return;
  }
  console.log(`  przebieg:    ${p.run} (gmina: ${p.town})`);
  console.log(`  model:       ${p.model}${p.confidence !== undefined ? ` · confidence ${p.confidence}` : ""}`);
  if (p.why) console.log(`  dlaczego:    ${p.why}`);
  console.log(`  z zapytania: ${p.query ?? "— (brak dopasowania do wyniku wyszukiwarki)"}`);
  if (p.hit) {
    console.log(`  wynik search:`);
    console.log(`      tytuł: ${p.hit.title ?? "—"}`);
    console.log(`      url:   ${p.hit.url ?? "—"}`);
    console.log(`      opis:  ${p.hit.desc ?? "—"}`);
  }
  if (p.firstFetch) console.log(`  1. pobranie: ${fmtProbe(p.firstFetch)}`);
  if (p.archive?.length) console.log(`  archiwum:    ${p.archive.join("\n               ")}`);
}

/**
 * Odpowiada na dwa pytania naraz: „czemu ten adres tu jest?" (proweniencja + historia weryfikacji)
 * oraz „czemu tego adresu tu NIE ma?" (ledger propozycji: duplikat / niska pewność / zły rekord).
 */
export function explain(needle: string, cfg: SourcesFile, runs: DiscoverRunReport[]): void {
  const q = needle.toLowerCase();
  const matches = cfg.sources.filter(
    (s) => s.id.toLowerCase() === q || s.id.toLowerCase().includes(q) ||
      s.url.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
  );

  if (matches.length === 0) console.log(`W rejestrze nie ma źródła pasującego do "${needle}".`);

  for (const src of matches) {
    console.log(`\n═══ ${src.id} — ${src.name}`);
    console.log(`  url:         ${src.url}`);
    console.log(`  gmina/typ:   ${src.town} · ${src.type} · fetch:${src.fetch}`);
    console.log(`  stan:        ${src.dead ? "💀 martwy" : src.verified ? "✅ zweryfikowany" : "niezweryfikowany"}` +
      `${src.checked ? ` (ostatnio sprawdzony ${src.checked})` : ""}` +
      `${src.discovered ? ` · dodane: ${src.discovered}` : ""}`);
    if (src.notes) console.log(`  notatki:     ${src.notes}`);
    if (src.previous_urls?.length) console.log(`  stare URL-e: ${src.previous_urls.join(", ")}`);
    printProvenance(src);

    const history = runs
      .flatMap((r) => r.verifications.filter((v) => v.id === src.id).map((v) => ({ r, v })))
      .sort((a, b) => a.r.startedAt.localeCompare(b.r.startedAt));
    if (history.length) {
      console.log("  historia weryfikacji:");
      for (const { r, v } of history) {
        console.log(`      ${r.startedAt.slice(0, 10)} ${OUTCOME_ICON[v.outcome]} ${v.outcome}` +
          `${v.probe ? ` · ${fmtProbe(v.probe)}` : v.httpStatus ? ` · HTTP ${v.httpStatus}` : ""}` +
          `${v.newUrl ? ` · → ${v.newUrl}` : ""}${v.err ? ` · ${v.err}` : ""}${v.note ? ` · ${v.note}` : ""}`);
      }
    }
  }

  // propozycje (także odrzucone) — jedyne miejsce, w którym widać, czemu czegoś NIE MA na liście
  const proposals = runs.flatMap((r) =>
    r.towns.flatMap((t) =>
      t.proposals
        .filter((p) =>
          p.id.toLowerCase().includes(q) || p.url.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q))
        .map((p) => ({ at: r.startedAt, town: t.town, p })),
    ),
  );
  if (proposals.length) {
    console.log(`\n═══ propozycje w przebiegach (${proposals.length})`);
    for (const { at, town, p } of proposals) {
      console.log(`  ${at.slice(0, 10)} ${town} ${DECISION_ICON[p.decision]} ${p.decision} — ${p.name} (${p.url})`);
      if (p.confidence !== undefined) console.log(`      confidence: ${p.confidence}`);
      if (p.why) console.log(`      dlaczego:   ${p.why}`);
      if (p.reason) console.log(`      powód:      ${p.reason}`);
      if (p.query) console.log(`      z zapytania: ${p.query}`);
    }
  } else if (matches.length === 0) {
    console.log("Żaden przebieg w discover-runs.json nie proponował takiego adresu.");
    console.log("Możliwe przyczyny: nie było go w wynikach wyszukiwarki, gmina nie była objęta discovery,");
    console.log("albo przebieg, który go rozpatrywał, wypadł już z historii (ostatnie 24).");
  }
}
