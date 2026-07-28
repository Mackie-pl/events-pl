/**
 * Sonda: przetworzenie JEDNEGO źródła na żądanie, bez żadnego zapisu.
 *
 * Po co osobno od daily.ts: żeby obejrzeć w panelu, co robi jedno źródło, nie chcemy
 * czekać do 6:00 ani puszczać 46 źródeł (pełny przebieg to minuty i realne pieniądze
 * za tokeny). Tu leci dokładnie ten sam `processSource`, więc sonda pokazuje zachowanie
 * potoku, a nie jego uproszczoną imitację.
 *
 * NIENARUSZALNA ZASADA: ta funkcja NICZEGO NIE ZAPISUJE.
 * Ani events.json, ani state.json, ani runs.json, ani costs.json, ani audit.json. Klik
 * w panelu nie ma prawa ruszyć plików w repo — inaczej każde sprawdzenie źródła brudzi
 * drzewo robocze i wchodzi do najbliższego commita, a zapisany cache ekstrakcji zafałszuje
 * najbliższy przebieg crona („niezmienione" mimo że nikt tej treści nie opublikował).
 * `processSource` mutuje przekazany `state` — dlatego dostaje obiekt wczytany świeżo na
 * potrzeby tego wywołania, który zaraz potem idzie do kosza.
 *
 * Dlaczego czyta ze składowiska (rejestr źródeł + stan), skoro reszta pipeline/ tego nie robi:
 * sonda jest jedynym wejściem do potoku, które startuje z samego ID źródła. Alternatywą było
 * powtórzenie wczytywania w dwóch wejściach (CLI i most panelu) i rozjazd między nimi —
 * a razem z nim rozjazd w zasadzie „bez zapisu", która musi mieszkać w jednym pliku.
 */
import { bdEnabled } from "../../adapters/brightdata.js";
import type { LlmCallRecord } from "../../adapters/openrouter.js";
import { setCallRecorder } from "../../adapters/openrouter.js";
import { suppressArchive } from "../../adapters/supabase-archive.js";
import { RUN_SCOPE, auditTrails, beginAuditRun, beginAuditSource } from "../../shared/audit.js";
import { sourcesStore, stateStore } from "../../storage/index.js";
import type {
  PipelineError, PipelineState, ProbeLlmCall, ProbeResult, Source, SourceTrail,
} from "../../types/index.js";

import { processSource } from "./process-source.js";

/** Błąd sondy, który jest odpowiedzią dla użytkownika, a nie awarią — most mapuje `status` na HTTP. */
export class ProbeError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = "ProbeError";
  }
}

/**
 * Czego sonda nie umie sprawdzić pojedynczo — z powodem do pokazania w panelu.
 *
 * `dead` NIE jest tu celowo: sprawdzenie, czy martwy adres wrócił do życia, to dokładnie
 * ten przypadek, dla którego sonda powstała. Cron go pomija, człowiek ma prawo spróbować.
 */
function unsupported(src: Source): string | null {
  if (src.fetch === "fb") {
    return "fanpage FB — osobny dataset Bright Data, poza zakresem daily (i tej sondy)";
  }
  if (src.fetch === "fb_event") {
    return "link do wydarzenia FB — rozwiązywany zbiorczo dla całego przebiegu, nie per źródło";
  }
  if (src.fetch === "fb_group" && !bdEnabled()) {
    return "grupa FB wymaga BRIGHTDATA_API_KEY — bez klucza nie ma czym pobrać postów";
  }
  return null;
}

/**
 * Zapomina wszystko, co pozwoliłoby pominąć pobranie i model dla tego źródła:
 * walidatory HTTP (bez nich serwer nie odpowie 304), hash treści i zapamiętane wydarzenia
 * — razem z followupami, bo plakat z cache dałby ten sam wynik co wczoraj.
 *
 * Cache geokodera zostaje nietknięty świadomie: Nominatim jest darmowy, ale limitowany
 * do 1 zapytania na sekundę, a sonda sprawdza ekstrakcję, nie geokodowanie.
 */
export function forgetSource(state: PipelineState, id: string): void {
  const cache = state.extractions ?? {};
  delete cache[id];
  for (const url of state.followupsBySource?.[id] ?? []) delete cache[url];
  delete state.hashes[id];
}

/** Obrazy (plakat w base64) zamieniamy na opis: prompt ma być czytelny, nie ma być megabajtem. */
function toProbeCall(rec: LlmCallRecord): ProbeLlmCall {
  const user = typeof rec.user === "string"
    ? rec.user
    : rec.user
        .map((p) => (p.type === "text" ? p.text : `[obraz, ${p.image_url.url.length} B base64]`))
        .join("\n");
  return {
    task: rec.task, model: rec.model, system: rec.system, user, response: rec.response,
    usage: rec.usage, ms: rec.ms, ok: rec.ok, ...(rec.err ? { err: rec.err } : {}),
  };
}

const EMPTY_TRAIL = (id: string): SourceTrail => ({ id, steps: [] });

export async function probeSource(id: string, opts: { force?: boolean } = {}): Promise<ProbeResult> {
  const cfg = await sourcesStore.load();
  const src = cfg.sources.find((s) => s.id === id);
  if (!src) throw new ProbeError(`Nie ma źródła o id „${id}" w rejestrze`, 404);
  const reason = unsupported(src);
  if (reason) throw new ProbeError(reason, 400);

  const state = await stateStore.load(); // kopia na tę jedną sondę — nigdzie nie wraca
  const force = opts.force ?? false;
  if (force) forgetSource(state, id);

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const errors: PipelineError[] = [];
  const llm: ProbeLlmCall[] = [];

  // Stan modułowy: ślad, recorder i wyłącznik archiwum są globalne dla procesu, więc most
  // puszcza sondy pojedynczo (patrz panel-server.ts) — dwie równoległe pomieszałyby ślady.
  beginAuditRun();
  beginAuditSource(id);
  suppressArchive(true);
  setCallRecorder((rec) => { llm.push(toProbeCall(rec)); });
  try {
    // Linki do wydarzeń FB wyłuskane po drodze trafiają tu w próżnię: rozwiązuje je jedno
    // zbiorcze zapytanie na końcu PEŁNEGO przebiegu, którego sonda z definicji nie robi.
    const { events, run } = await processSource(src, state, errors, new Set<string>());
    const trail = auditTrails().find((t) => t.id === id) ?? EMPTY_TRAIL(id);
    return {
      sourceId: id, startedAt, ms: Math.round(performance.now() - t0), forced: force,
      run, trail, events, errors, llm,
    };
  } finally {
    setCallRecorder(null);
    suppressArchive(false);
    beginAuditSource(RUN_SCOPE);
  }
}
