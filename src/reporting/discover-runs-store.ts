/**
 * Polityka przechowywania przebiegów discover: ile trzymamy i co odchudzamy.
 * Mieszka w reporting/, a nie w storage/, bo to decyzja produktowa („ile historii
 * jest warte miejsca w publicznym repo"), a nie szczegół składowania.
 */
import { collection } from "../storage/index.js";
import type { CollectionStore, Retention } from "../storage/index.js";
import type {
  DiscoverRunReport, SearchCall, SourceProposal, SourceVerification, TownDiscoveryRun,
} from "../types/index.js";

/** ~2 lata miesięcznych przebiegów. */
const KEEP = 24;
/**
 * Pełne szczegóły (wyniki wyszukiwarki, dopasowane trafienia) trzymamy tylko dla najnowszych
 * przebiegów — pełne discovery to ~13 gmin × 10 zapytań × 8 wyników, czyli setki kB na przebieg
 * w publicznym repo. Starsze zostają jako metryki + decyzje; „czemu to źródło tu jest"
 * i tak odpowiada `provenance` w sources.json.
 */
const DETAILED = 4;

function slim(r: DiscoverRunReport): DiscoverRunReport {
  if (r.slimmed) return r;
  const slimSearches = (calls: SearchCall[]): SearchCall[] =>
    calls.map((c) => (c.results.length ? { ...c, results: [], trimmed: c.results.length } : c));
  return {
    ...r,
    slimmed: true,
    towns: r.towns.map((t) => ({
      ...t,
      searches: slimSearches(t.searches),
      proposals: t.proposals.map(({ hit: _hit, ...p }) => p),
    })),
    verifications: r.verifications.map((v) => ({ ...v, searches: slimSearches(v.searches) })),
  };
}

/**
 * Kształt przebiegu tak, jak leży na dysku: przebiegi zapisane starszą wersją nie mają
 * `proposals` ani nowych pól. Czytamy plik z historii, więc typy z types.ts opisują tu
 * intencję, a nie gwarancję — normalizujemy przy wczytaniu, zamiast rozsypywać `?? []`.
 */
type StoredRun = Omit<DiscoverRunReport, "towns" | "verifications"> & {
  towns?: Array<Omit<TownDiscoveryRun, "searches" | "proposals"> & { searches?: SearchCall[]; proposals?: SourceProposal[] }>;
  verifications?: Array<Omit<SourceVerification, "searches"> & { searches?: SearchCall[] }>;
};

const normalizeRun = (r: StoredRun): DiscoverRunReport => ({
  ...r,
  towns: (r.towns ?? []).map((t) => ({ ...t, searches: t.searches ?? [], proposals: t.proposals ?? [] })),
  verifications: (r.verifications ?? []).map((v) => ({ ...v, searches: v.searches ?? [] })),
});

export const discoverRunsRetention: Retention<DiscoverRunReport> = {
  at: (r) => r.startedAt,
  maxKeep: KEEP,
  slim: { keepDetailed: DETAILED, slim },
  normalize: (raw) => normalizeRun(raw as StoredRun),
};

export const discoverRunsStore: CollectionStore<DiscoverRunReport> =
  collection<DiscoverRunReport>("discover-runs", discoverRunsRetention);
