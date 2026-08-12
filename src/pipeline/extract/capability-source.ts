/**
 * Ścieżka maszynowa etapu 2: gdy źródło ma potwierdzone wyjście `tribe`/`ical`/`jsonld`,
 * bierzemy gotowe rekordy zamiast skrobać HTML i płacić modelowi za odczytanie z niego dat.
 *
 * Dlaczego osobny moduł, a nie gałąź w process-source.ts: tamten plik trzyma parowanie
 * liczników kosztu i jest tuż pod progiem max-lines. Tu mieszka CAŁA ścieżka maszynowa —
 * pobranie, cache i mapowanie — a process-source.ts pyta ją jednym wywołaniem.
 *
 * Kontrakt: `null` znaczy „użyj zwykłej ścieżki (strona + model)". Zwracamy go przy braku
 * zdolności, nieudanym pobraniu i przy PUSTYM plonie — feed potrafi opustoszeć poza sezonem,
 * a cisza tam, gdzie wczoraj było dziesięć wydarzeń, byłaby regresem, nie oszczędnością.
 * Każde takie zejście zostawia ślad `capability.fallback`, żeby nie było ciche.
 */
import { type Fetched, fetchRaw, validators } from "../../adapters/page-fetch.js";
import { archiveRaw } from "../../adapters/supabase-archive.js";
import { audit } from "../../shared/audit.js";
import { todayIso } from "../../shared/dates.js";
import { describeError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hash.js";
import type {
  CachedExtraction, EventItem, PipelineState, Source, SourceCapability, SourceRun,
} from "../../types/index.js";

import { detach } from "./block-cache.js";
import {
  bestCapability, type CapabilityYield, capabilityEvents, hashableFeed,
} from "./from-capability.js";

/** „2 zakończone, 1 bez daty" — puste, gdy nic nie odpadło. */
function dropNote(d: CapabilityYield["dropped"]): string {
  const parts = [
    d.past ? `${d.past} zakończonych` : "",
    d.noDate ? `${d.noDate} bez daty` : "",
    d.noTitle ? `${d.noTitle} bez tytułu` : "",
  ].filter(Boolean);
  return parts.length ? ` (odpadło: ${parts.join(", ")})` : "";
}

const anyDrop = (d: CapabilityYield["dropped"]): boolean => d.past + d.noDate + d.noTitle > 0;

/** Wydarzenia z cache — treść wyjścia maszynowego się nie zmieniła, mapowania nie powtarzamy. */
function replay(cached: CachedExtraction, cap: SourceCapability, run: SourceRun): EventItem[] {
  run.changed = false;
  run.cached = cached.events.length;
  run.structured = {
    kind: cap.kind, url: cap.url, seen: cached.events.length, items: cached.events.length,
  };
  audit("cache.hit", `${cached.events.length} wydarzeń z cache (mapowanie z ${cached.at.slice(0, 10)})`,
    { events: cached.events.length, since: cached.at });
  return cached.events;
}

/**
 * Pobranie wyjścia maszynowego wraz z rozstrzygnięciem „czy w ogóle jest co mapować".
 * `events` = treść bez zmian, plon odtworzony z cache. `body` = jest nowa treść.
 * `null` = wywołujący ma zejść na ścieżkę modelu (powód już zapisany w śladzie).
 */
async function fetchFeed(
  cap: SourceCapability, src: Source, state: PipelineState, run: SourceRun,
): Promise<{ events: EventItem[] } | { body: Fetched } | null> {
  const cached = (state.extractions ??= {})[src.id];

  let fetched: Fetched;
  try {
    fetched = await fetchRaw(cap.url, validators(cached));
  } catch (e) {
    audit("capability.fallback",
      `pobranie „${cap.kind}" nieudane (${describeError(e)}) — wracamy na stronę i model`,
      { url: cap.url, kind: cap.kind });
    return null;
  }

  run.httpStatus = fetched.httpStatus;
  run.kind = "feed";
  audit("fetch", `wyjście maszynowe „${cap.kind}" — HTTP ${fetched.httpStatus}`,
    { url: cap.url, strategy: cap.kind, httpStatus: fetched.httpStatus });

  if (fetched.kind === "not-modified") {
    if (!cached) {
      audit("capability.fallback", "HTTP 304, ale nie mamy nic w cache — wracamy na stronę i model",
        { url: cap.url, kind: cap.kind });
      return null;
    }
    audit("content", "HTTP 304 — serwer potwierdził brak zmian, treści w ogóle nie pobieraliśmy");
    return { events: detach(replay(cached, cap, run)) };
  }

  run.chars = fetched.text.length;
  await archiveRaw(src.id, cap.url, fetched.text, cap.kind);
  return { body: fetched };
}

export async function capabilitySource(
  src: Source, state: PipelineState, run: SourceRun,
): Promise<EventItem[] | null> {
  const cap = bestCapability(src.capabilities);
  if (!cap) return null;

  audit("capability", `źródło oddaje „${cap.kind}" — bierzemy gotowe rekordy zamiast skrobać HTML`,
    { kind: cap.kind, url: cap.url, itemsSeen: cap.itemsSeen, checked: cap.checked });

  const got = await fetchFeed(cap, src, state, run);
  if (got === null) return null;
  if ("events" in got) return got.events;

  const fetched = got.body;
  const cache = (state.extractions ??= {});
  const cached = cache[src.id];
  // hash liczony z treści BEZ pól przepisywanych co pobranie (patrz hashableFeed) — inaczej
  // `tribe` i `ical` mijają się z cache'em każdej doby, choć kalendarz stoi w miejscu
  const hash = sha256(hashableFeed(cap.kind, fetched.text));
  const v = {
    ...(fetched.etag ? { etag: fetched.etag } : {}),
    ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
  };

  if (cached?.hash === hash) {
    cache[src.id] = { ...cached, ...v, at: new Date().toISOString() };
    audit("content", `${fetched.text.length} znaków, ten sam hash co poprzednio — bez ponownego mapowania`,
      { chars: fetched.text.length, hash: hash.slice(0, 12) });
    return replay(cached, cap, run);
  }

  run.changed = true;
  audit("content", `${fetched.text.length} znaków, hash inny niż poprzednio — mapujemy rekordy`,
    { chars: fetched.text.length, hash: hash.slice(0, 12), was: cached?.hash.slice(0, 12) ?? null });

  const plon = capabilityEvents(cap.kind, fetched.text, cap.url, todayIso());
  run.structured = {
    kind: cap.kind, url: cap.url, seen: plon.seen, items: plon.events.length,
    ...(anyDrop(plon.dropped) ? { dropped: plon.dropped } : {}),
  };
  audit("capability.parsed",
    `${plon.seen} rekordów → ${plon.events.length} wydarzeń${dropNote(plon.dropped)}, bez wywołania modelu`,
    {
      kind: cap.kind, seen: plon.seen, events: plon.events.length,
      past: plon.dropped.past, noDate: plon.dropped.noDate, noTitle: plon.dropped.noTitle,
    });

  if (!plon.events.length) {
    run.structured.fellBack = true;
    audit("capability.fallback",
      `„${cap.kind}" nie dał ani jednego wydarzenia — wracamy na stronę i model`,
      { url: cap.url, kind: cap.kind, seen: plon.seen });
    return null;
  }

  // Miasto z gminy źródła, gdy feed go nie niesie (iCal nie ma takiego pola, `tribe` bywa
  // bez `venue.city`). Bez tego geokoder dostaje samą nazwę sali i częściej pudłuje.
  // Tu, a nie w attachGeo: tam `??=` celowo nie rusza `""` i zmiana ruszyłaby ścieżkę modelu.
  for (const ev of plon.events) ev.town ||= src.town;

  cache[src.id] = { hash, events: detach(plon.events), at: new Date().toISOString(), ...v };
  state.hashes[src.id] = hash; // legacy, dla zgodności ze starym state.json
  return plon.events;
}
