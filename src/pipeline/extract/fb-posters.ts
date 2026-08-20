/**
 * Czytanie plakatów z grup FB — jedyne miejsce, w którym załącznik postu dochodzi do modelu.
 *
 * DLACZEGO w ogóle, w liczbach z przebiegu 2026-08-19 (`fb-poster-yield.ts`): posty z obrazem
 * milczą w 90% wobec 53% bez obrazu, a te, które coś oddają, gubią miejsce i godzinę w 57%
 * wobec 0%. Oba rozkłady wskazują to samo — treść stoi na grafice. Dwa plakaty obejrzane
 * ręcznie (salsa w Cafe Pod Minogą 19.08, szkolenia dla seniorów w Mosinie 18.08) miały
 * komplet danych i ANI JEDNEGO odpowiednika w events.json. Ten na drugim niósł jeszcze
 * czerwony nadruk „SZKOLENIA ODWOŁANE", czyli informację, przez którą brak odczytu plakatu
 * to nie tylko luka w pokryciu, ale i ryzyko wysłania odwołanego wydarzenia w digeście.
 *
 * DLACZEGO BEZ SITA PRZED ODCZYTEM: patrz `fbPosterJobs` w facebook.ts — ani proporcje, ani
 * bajty/piksel nie oddzielają plakatu od ogłoszenia o przeprowadzkach. Sito i tak nie miałoby
 * z czego się zwrócić: wywołanie wizyjne kosztuje ZMIERZONE ~$0.001 (2026-08-19: $0.0011 za
 * plakat salsy, $0.0010 za borówki, $0.0006 za ogłoszenie CNC), a płatne OCR ~$0.0015 — czyli
 * WIĘCEJ niż czytanie. Odsiew robi zresztą sam model: oba śmieciowe obrazy oddały pustą listę.
 * Sterujemy więc SUFITEM liczby odczytów, nie zgadywaniem z pikseli.
 *
 * Rekord Bright Data jest zapłacony, zanim tu dojdziemy — to jest cała ekonomia tej ścieżki.
 */
import { fetchImageB64 } from "../../adapters/page-fetch.js";
import { P } from "../../config/params.js";
import { audit } from "../../shared/audit.js";
import { detach } from "./block-cache.js";
import { authorKey, authorMuted, noteAuthorRead, pruneAuthors } from "./fb-author-mute.js";
import type { EventItem, PipelineState } from "../../types/index.js";
import type { FbPosterJob } from "../facebook.js";

import { extractPoster } from "./extract.js";

/**
 * Licznik na PRZEBIEG, nie na źródło. Sufit jest wspólny, bo koszt jest wspólny — inaczej
 * dwadzieścia grup po „tylko pięć plakatów" robi sto wywołań i sufit per źródło niczego
 * nie pilnuje. Zeruje go `resetFbPosters()` na starcie przebiegu, tak samo jak liczniki zużycia.
 */
let readThisRun = 0;

/** Czytane przez funkcję, nie stałą modułową — testy przestawiają konfigurację w locie. */
const posterCap = (): number => P.FB_POSTER_MAX_PER_RUN.get();

export const fbPostersRead = (): number => readThisRun;

/**
 * Po tylu dniach wpis „ten plakat nic nie niósł" wypada z cache'u. Nie po to, żeby czytać
 * go ponownie — grafika pod tym samym adresem się nie zmienia — tylko po to, żeby `state.json`
 * nie puchł w nieskończoność. Plik jest COMMITOWANY, a ~50 wpisów dziennie, z których
 * większość jest pusta, w rok robi z niego megabajty szumu w historii repo.
 */
const EMPTY_POSTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Start przebiegu: zeruje sufit i przycina cache. Wołane RAZ z `daily.ts`, nie z
 * `processSource` — sufit jest wspólny dla wszystkich źródeł, więc zerowanie per źródło
 * czyniłoby go bezużytecznym (dwadzieścia grup po „tylko pięć plakatów" to sto wywołań).
 */
export function startFbPosterRun(state: PipelineState, today: string): void {
  readThisRun = 0;
  pruneAuthors(state, today);
  const cache = state.extractions;
  if (!cache) return;
  let dropped = 0;
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith("fbposter:")) continue;
    const stale = entry.events.length
      ? entry.events.every((ev) => (ev.date_end ?? ev.date_start) < today)
      : Date.now() - Date.parse(entry.at) > EMPTY_POSTER_TTL_MS;
    if (stale) { delete cache[key]; dropped += 1; }
  }
  if (dropped) {
    audit("fb.group", `${dropped} wpisów plakatów wypadło z cache (minione albo puste od 30 dni)`,
      { dropped });
  }
}

/**
 * Klucz cache'u plakatu: host + ścieżka, BEZ parametrów.
 *
 * Adres z fbcdn jest podpisany i wygasa (`oh`/`oe` zmieniają się przy każdym pobraniu grupy),
 * więc klucz z pełnego URL-a nie trafiłby NIGDY — ten sam plakat byłby czytany codziennie,
 * póki post wisi w oknie. W ścieżce siedzi stabilne id zasobu i to ono jest tożsamością.
 */
export function posterKey(imageUrl: string): string {
  try {
    const u = new URL(imageUrl);
    return `fbposter:${u.host}${u.pathname}`;
  } catch {
    return `fbposter:${imageUrl}`;
  }
}

/** Wydarzenie z plakatu ma wskazywać POST, nie plik graficzny — inaczej nie ma go jak otworzyć. */
function stamp(events: EventItem[], postUrl: string): EventItem[] {
  for (const ev of events) if (!ev.source_url) ev.source_url = postUrl;
  return events;
}

async function readOne(
  job: FbPosterJob, state: PipelineState,
): Promise<EventItem[] | null> {
  const key = posterKey(job.imageUrl);
  const cache = (state.extractions ??= {});
  const hit = cache[key];
  if (hit) {
    audit("fb.group", `plakat już czytany — ${hit.events.length} wydarzeń z cache, bez wywołania`,
      { url: job.postUrl, events: hit.events.length, since: hit.at });
    return stamp(detach(hit.events), job.postUrl);
  }

  const img = await fetchImageB64(job.imageUrl);
  if (!img || img.notModified) {
    // pobranie obrazu ma własny status: „nie udało się" to nie to samo, co „plakat bez wydarzeń"
    audit("fb.group", "plakatu nie udało się pobrać — post zostaje z samym tekstem",
      { url: job.postUrl, image: job.imageUrl });
    return null;
  }

  readThisRun += 1;
  const out = await extractPoster(
    { data: img.data, mediaType: img.mediaType }, job.postUrl, job.context,
  );
  const events = stamp(out.events, job.postUrl);
  // licznik autora dostaje WYNIK, nie sam fakt odczytu — zero wydarzeń zbliża do wyciszenia,
  // jedno wydarzenie kasuje historię (patrz fb-author-mute.ts)
  noteAuthorRead(authorKey(job.author), events.length, state);
  // zapis także przy zerze wydarzeń — „ten plakat nic nie niesie" jest wynikiem wartym
  // zapamiętania dokładnie tak samo jak lista wydarzeń, i chroni przed płaceniem drugi raz
  cache[key] = { hash: key, events: detach(events), at: new Date().toISOString() };
  return events;
}

/**
 * Przeczytaj plakaty z jednej grupy. Zwraca wydarzenia do dorzucenia do reszty źródła.
 *
 * Porażka jednego plakatu nie przerywa pozostałych ani całego źródła: obraz z fbcdn bywa
 * nieosiągalny (edge scrapera), a opłacony rekord i tak został przeczytany tekstem.
 */
export async function readFbPosters(
  jobs: FbPosterJob[], state: PipelineState,
): Promise<EventItem[]> {
  const cap = posterCap();
  if (!cap || !jobs.length) return [];
  // sufit źródła liczony od stanu NA WEJŚCIU, nie od zera: inaczej to samo źródło wywołane
  // dwa razy (strona + followupy) dostawałoby pulę od nowa
  const perSource = P.FB_POSTER_MAX_PER_SOURCE.get();
  const startedAt = readThisRun;

  const out: EventItem[] = [];
  let capped = 0;
  let byRun = 0;
  let muted = 0;
  for (const job of jobs) {
    // PRZED sufitami: wyciszony autor nie ma zajmować miejsca w puli — to jest cały powód,
    // dla którego ten mechanizm powstał (2026-08-20 zabrakło miejsc, nie pieniędzy)
    if (authorMuted(authorKey(job.author), state)) { muted += 1; continue; }
    if (readThisRun >= cap) { capped += 1; byRun += 1; continue; }
    if (perSource && readThisRun - startedAt >= perSource) { capped += 1; continue; }
    try {
      const events = await readOne(job, state);
      if (events) out.push(...events);
    } catch (e) {
      audit("fb.group", "odczyt plakatu padł — post zostaje z samym tekstem",
        { url: job.postUrl, err: e instanceof Error ? e.message : String(e) });
    }
  }
  if (capped) {
    // rozróżnienie ma znaczenie dla diagnozy: „sufit źródła" znaczy, że pula jeszcze jest
    // i dostaną ją następne grupy, „sufit przebiegu" — że skończyła się dla wszystkich
    audit("fb.group",
      byRun === capped
        ? `${capped} plakatów pominiętych — sufit ${cap} odczytów na przebieg wyczerpany`
        : `${capped} plakatów pominiętych — limit ${perSource} na źródło (pula przebiegu: `
          + `${cap - readThisRun} wolnych)`,
      { skipped: capped, byRun, cap, perSource, read: readThisRun });
  }
  audit("fb.group",
    `plakaty: ${jobs.length} do przeczytania → ${out.length} wydarzeń`
    + (muted ? ` (${muted} pominiętych — autor wyciszony)` : ""),
    { jobs: jobs.length, events: out.length, muted, readThisRun, cap });
  return out;
}
