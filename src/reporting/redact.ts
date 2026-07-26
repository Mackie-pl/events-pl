/**
 * Co jest czyszczone przed zapisem do PUBLICZNEGO repo. Trzymane w jednym miejscu
 * celowo: to polityka bezpieczeństwa, a nie szczegół raportu — musi dać się przeczytać
 * w całości, bez zbierania po pięciu plikach.
 */
import { type RedactionStats, newStats, redactText } from "../pipeline/pii.js";
import type { DiscoverRunReport, SearchCall, SearchResult, SourcesFile } from "../types/index.js";

export function redactDiscoverRun(report: DiscoverRunReport, cfg: SourcesFile): void {
  const stats: RedactionStats = newStats();
  /** In-place, tylko dla realnych stringów — przy exactOptionalPropertyTypes nie wolno wstawić undefined. */
  const red = <T extends object, K extends keyof T>(o: T | undefined, k: K): void => {
    if (!o) return;
    const v = o[k];
    if (typeof v === "string") o[k] = redactText(v, stats) as T[K];
  };
  const redHit = (h: SearchResult | undefined): void => {
    red(h, "title");
    red(h, "desc");
  };
  const redSearches = (calls: SearchCall[]): void => {
    for (const c of calls) {
      red(c, "err");
      for (const r of c.results) redHit(r);
    }
  };

  const redTowns = (): void => {
    for (const town of report.towns) {
      red(town, "err");
      redSearches(town.searches);
      for (const p of town.proposals) {
        red(p, "name");
        red(p, "why");
        red(p, "reason");
        redHit(p.hit);
      }
    }
  };
  const redVerifications = (): void => {
    for (const v of report.verifications) {
      red(v, "err");
      red(v, "note");
      redSearches(v.searches);
      red(v.probe, "err");
      red(v.candidateProbe, "err");
    }
  };
  // sources.json też jest publiczny — proweniencja niesie opis wyniku wyszukiwarki
  const redSources = (): void => {
    for (const s of cfg.sources) {
      red(s, "notes");
      if (!s.provenance) continue;
      red(s.provenance, "why");
      redHit(s.provenance.hit);
      red(s.provenance.firstFetch, "err");
    }
  };

  red(report, "err");
  red(report.geo, "err");
  redTowns();
  redVerifications();
  redSources();
  report.totals.redactedPhones = stats.phones;
  report.totals.redactedEmails = stats.emails;
}

/** Starszy przebieg bez szczegółów: zostają metryki i decyzje, znika masa wyników wyszukiwarki. */
