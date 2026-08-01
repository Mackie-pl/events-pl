/**
 * Rozliczenie entrypointów z plonu: adres, który przestał cokolwiek dawać, wypada z rejestru.
 *
 * Przesłuchanie przy discovery (`entrypoint-audition.ts`) pilnuje NARODZIN — nie wpuszcza
 * adresu, który od razu nic nie daje. Ten moduł pilnuje ROZKŁADU: serwis przenosi kalendarz,
 * dział zostaje pusty, a rejestr trzyma adres w nieskończoność, bo nic nie łączyło wyniku
 * ekstrakcji z wiarygodnością wejścia. Do lipca 2026 nie było ŻADNEJ ścieżki, którą zły
 * entrypoint mógłby zniknąć — ani daily, ani verify go nie dotykały.
 *
 * Dowód bierzemy z cache'u ekstrakcji: entrypoint jest pobierany przez `daily` jako followup,
 * więc `state.extractions[url].events` to dokładnie „ile wydarzeń dał ten adres ostatnim razem".
 * Żadnego nowego stanu — i żadnego drugiego pisarza do `state.json`, którego właścicielem
 * pozostaje `daily`.
 */
import { todayIso } from "../../shared/dates.js";
import { urlKey } from "../../shared/url.js";
import type { EntryPoint, PipelineState, Source } from "../../types/index.js";

/** Po tylu kolejnych przebiegach bez wydarzeń entrypoint wypada z rejestru. */
export const BARREN_LIMIT = 2;

export interface YieldResult {
  /** adresy usunięte w tym przebiegu: id źródła → adres */
  dropped: Array<{ id: string; url: string; runs: number }>;
}

/** Ile wydarzeń dał ten adres przy ostatniej ekstrakcji; `null` = nigdy nie był pobierany. */
function lastYield(url: string, state: PipelineState): number | null {
  const cache = state.extractions ?? {};
  const direct = cache[url.replace("{page}", "1")] ?? cache[url];
  if (direct) return direct.events.length;
  // followupy zapisują się pod adresem, którym je pobrano — szukamy po kluczu URL-a,
  // bo szablon z {page} i adres z podstawioną jedynką to ten sam zasób
  const key = urlKey(url.replace("{page}", "1"));
  const hit = Object.entries(cache).find(([k]) => urlKey(k) === key);
  return hit ? hit[1].events.length : null;
}

/**
 * Nalicza jałowe przebiegi i usuwa entrypointy, które przekroczyły próg.
 *
 * `null` (nigdy nie pobierany) NIE liczy się jako pudło: adres dopiero co wszedł do rejestru
 * albo `daily` go nie dotknęło, a karanie za brak pomiaru dawałoby ten sam błąd co karanie
 * źródła za brak trafienia w wyszukiwarce.
 */
export function reconcileEntrypoints(
  sources: readonly Source[], state: PipelineState,
): YieldResult {
  const out: YieldResult = { dropped: [] };

  for (const src of sources) {
    if (!src.entrypoints?.length) continue;
    const kept: EntryPoint[] = [];

    for (const entry of src.entrypoints) {
      const events = lastYield(entry.url, state);
      if (events === null) { kept.push(entry); continue; }
      if (events > 0) {
        // plon zeruje licznik — adres udowodnił, że działa
        const { barrenRuns: _drop, ...proven } = entry;
        kept.push(proven);
        continue;
      }

      const runs = (entry.barrenRuns ?? 0) + 1;
      if (runs < BARREN_LIMIT) { kept.push({ ...entry, barrenRuns: runs }); continue; }
      out.dropped.push({ id: src.id, url: entry.url, runs });
    }

    if (kept.length) src.entrypoints = kept;
    else delete src.entrypoints;
  }
  return out;
}

/**
 * Przeniesienie liczników na świeżo rozpoznany profil.
 *
 * `applyProfile` nadpisuje entrypointy w całości — i słusznie, bo opisują stan serwisu z chwili
 * sprawdzenia. Ale licznik jałowych przebiegów jest wiedzą O ADRESIE zbieraną przez miesiące,
 * więc bez przeniesienia zerowałby się co przebieg i próg `BARREN_LIMIT` nigdy by nie zadziałał.
 */
export function carryBarrenRuns(
  fresh: readonly EntryPoint[], previous: readonly EntryPoint[] | undefined,
): EntryPoint[] {
  if (!previous?.length) return [...fresh];
  const byKey = new Map(previous.map((e) => [urlKey(e.url), e]));
  return fresh.map((e) => {
    const before = byKey.get(urlKey(e.url));
    return before?.barrenRuns ? { ...e, barrenRuns: before.barrenRuns } : e;
  });
}

/** Notatka na źródle po usunięciu wejścia — żeby ślad został także po przycięciu przebiegów. */
export const dropNote = (url: string, runs: number): string =>
  `${todayIso()}: usunięto wejście ${url} — ${runs} przebiegi bez ani jednego wydarzenia`;
