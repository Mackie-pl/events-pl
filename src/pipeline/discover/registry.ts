/** Rejestr źródeł w pamięci: co już znamy, żeby nie wpuścić duplikatu ani nie nadpisać id. */
import { urlKey } from "../../shared/url.js";
import type { SourcesFile } from "../../types/index.js";

export interface Registry {
  cfg: SourcesFile;
  /** urlKey wszystkich znanych adresów */
  urls: Map<string, string>; // urlKey -> id źródła
  ids: Set<string>;
  /** id dodane w TYM przebiegu — ich weryfikacja to pierwszy fetch w życiu źródła */
  fresh: Set<string>;
}

export function buildRegistry(cfg: SourcesFile): Registry {
  const urls = new Map<string, string>();
  const ids = new Set<string>();
  for (const s of cfg.sources) {
    urls.set(urlKey(s.url), s.id);
    ids.add(s.id);
  }
  return { cfg, urls, ids, fresh: new Set() };
}

/** Wolne id o tym samym rdzeniu — kolizja scaliłaby cache ekstrakcji dwóch różnych stron. */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
