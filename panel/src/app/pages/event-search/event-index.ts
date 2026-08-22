import { eventKey, fold } from '../../event-identity';
import type { EventItem, EventRef, RunReport, SourceRun } from '../../types';

/** Jedno wystąpienie wydarzenia: który przebieg, które źródło, jaką drogą. */
export interface Sighting {
  /** `startedAt` przebiegu — klucz trasy /run/:runId */
  run: string;
  sourceId: string;
  sourceName: string;
  town: string;
  status: SourceRun['status'];
  /** adres, spod którego wyszedł ten rekord */
  url: string;
  /** rekord przyszedł spod innego adresu niż strona źródła — czyli z followupa/podstrony */
  viaFollowup: boolean;
  /** id źródła, którego rekord wygrał dedupe; brak = ten poszedł do events.json */
  mergedInto?: string;
  /** zero wywołań modelu na tym źródle w tym przebiegu — wydarzenie odtworzone z cache */
  fromCache: boolean;
}

export interface EventHit {
  key: string;
  title: string;
  date: string;
  url: string;
  /** od najstarszego przebiegu — `sightings[0]` to moment, w którym wydarzenie POWSTAŁO */
  sightings: Sighting[];
  /** stoi w dzisiejszym events.json (przeszło dedupe i redakcję) */
  published: boolean;
}

/** Czy rekord jest wynikiem cache'u: źródło nie wołało modelu, a wydarzenia oddało. */
const cached = (s: SourceRun): boolean => s.llm.calls === 0 && s.events > 0;

function push(index: Map<string, EventHit>, run: string, src: SourceRun, ref: EventRef): void {
  const key = ref.key ?? eventKey(ref.title, ref.date);
  const hit = index.get(key) ?? {
    key, title: ref.title, date: ref.date, url: ref.url, sightings: [], published: false,
  };
  hit.sightings.push({
    run,
    sourceId: src.id,
    sourceName: src.name,
    town: src.town,
    status: src.status,
    url: ref.url,
    viaFollowup: ref.url !== src.url,
    fromCache: cached(src),
    ...(ref.mergedInto === undefined ? {} : { mergedInto: ref.mergedInto }),
  });
  index.set(key, hit);
}

/**
 * Skorowidz wydarzeń ze WSZYSTKICH zachowanych przebiegów (runs.json, 7 dni szczegółów).
 *
 * Wydarzenie z events.json, którego żaden przebieg nie tłumaczy, i tak wchodzi do skorowidza —
 * z pustą listą wystąpień. To jest odpowiedź „jest w digeście, ale ślad już wypadł z historii",
 * a milczenie wyszukiwarki wyglądałoby jak „takiego wydarzenia nigdy nie było".
 */
export function buildIndex(runs: RunReport[], events: EventItem[]): EventHit[] {
  const index = new Map<string, EventHit>();
  const chronological = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of chronological) {
    for (const src of run.sources) {
      for (const ref of src.produced ?? []) push(index, run.startedAt, src, ref);
    }
  }
  for (const e of events) {
    const key = eventKey(e.title, e.date_start);
    const hit = index.get(key);
    if (hit) hit.published = true;
    else index.set(key, {
      key, title: e.title, date: e.date_start, url: e.source_url, sightings: [], published: true,
    });
  }
  return [...index.values()];
}

/**
 * Trafność, nie filtr binarny: wszystkie słowa zapytania muszą wystąpić (bez względu na
 * kolejność — „dozynki lubon" ma znaleźć „Dożynki Gminy Luboń"), ale wynik z tytułu stoi
 * wyżej od wyniku, który pasuje tylko adresem albo nazwą źródła. Zwraca 0, gdy nie pasuje.
 */
export function score(hit: EventHit, words: string[]): number {
  const title = fold(hit.title);
  const rest = fold(
    [hit.url, hit.date, ...hit.sightings.map((s) => `${s.sourceName} ${s.sourceId} ${s.town}`)]
      .join(' '),
  );
  if (!words.every((w) => title.includes(w) || rest.includes(w))) return 0;
  if (words.every((w) => title.includes(w))) return title.startsWith(words[0] ?? '') ? 3 : 2;
  return 1;
}

/** Wyniki dla zapytania, od najtrafniejszych, a przy remisie od najbliższej daty. */
export function search(hits: EventHit[], query: string): EventHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return hits
    .map((h) => ({ h, s: score(h, words) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.h.date.localeCompare(b.h.date))
    .map((r) => r.h);
}
