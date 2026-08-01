/**
 * Przesłuchanie entrypointu, którego model nie potwierdził: jedna ekstrakcja zamiast trzydziestu.
 *
 * Adres wskazany samą heurystyką bywa pułapką — `lubon.pl/artykuly/350/wydarzenia` ma w ścieżce
 * słowo „wydarzenia" i 63 odnośniki o kształcie wpisu, a jest artykułem o cyklicznych imprezach.
 * Oba sygnały, po których heurystyka go wybrała, mierzą konwencję CMS-a, nie zawartość strony.
 *
 * Rachunek jest jednoznaczny i to on uzasadnia wydanie pieniędzy w etapie 1: bez sprawdzenia
 * taki adres wchodzi do rejestru i `daily` pobiera go oraz posyła do modelu CODZIENNIE —
 * ~30 ekstrakcji miesięcznie za stronę, o której już wiadomo, że nic nie da. Jedna ekstrakcja
 * przy discovery kosztuje ~$0.006 i zamyka sprawę.
 *
 * Sprawdzamy WYŁĄCZNIE `unendorsed`. Adres wskazany przez model ma już swoje potwierdzenie,
 * a płacenie za drugie byłoby podatkiem od wszystkich źródeł naraz.
 */
import { fetchPlain } from "../../adapters/page-fetch.js";
import { audit } from "../../shared/audit.js";
import { describeError } from "../../shared/errors.js";
import type { EntryPoint } from "../../types/index.js";
import { extractEvents } from "../extract/extract.js";

export interface AuditionResult {
  entrypoints: EntryPoint[];
  /** adresy odrzucone przesłuchaniem — do śladu przebiegu */
  rejected: Array<{ url: string; why: string }>;
}

/** Co przesłuchanie zastało pod adresem. `ok:false` = nie udało się w ogóle pobrać treści. */
export interface Audition {
  ok: boolean;
  events: number;
  err?: string;
}

/**
 * Werdykt na podstawie tego, co zastano. Czysta funkcja, bo to ona niesie regułę,
 * a nie mechanika pobierania.
 *
 * Nieudane pobranie NIE odrzuca entrypointu: sonda potrafi przegrać tam, gdzie wygrywa pełny
 * potok `daily` (inne nagłówki, w razie potrzeby przeglądarka), a kasowanie adresu za awarię
 * sieci to ta sama pomyłka, którą weto plonu zamyka po stronie weryfikacji.
 */
export function auditionVerdict(found: Audition): { keep: boolean; why: string } {
  if (!found.ok) {
    return { keep: true, why: `pobranie nieudane (${found.err ?? "brak treści"}) — nie odrzucamy za awarię sieci` };
  }
  return found.events > 0
    ? { keep: true, why: `${found.events} wydarzeń w próbnej ekstrakcji` }
    : { keep: false, why: "próbna ekstrakcja nie znalazła ani jednego wydarzenia" };
}

export type EntryProbe = (url: string) => Promise<Audition>;

/** Prawdziwe przesłuchanie: pobranie strony i jedna ekstrakcja. */
const liveProbe: EntryProbe = async (url) => {
  let text: string;
  try {
    const got = await fetchPlain(url);
    if (got.kind === "not-modified") return { ok: false, events: 0, err: "304" };
    text = got.text;
  } catch (e) {
    return { ok: false, events: 0, err: describeError(e) };
  }
  if (!text.trim()) return { ok: true, events: 0 };
  const { events } = await extractEvents(text, url);
  return { ok: true, events: events.length };
};

/**
 * Odsiew entrypointów niepotwierdzonych przez model. Pozostałe przechodzą bez kosztu.
 * `probe` jest wstrzykiwane, żeby regułę dało się przetestować bez sieci i bez modelu.
 */
export async function auditionEntrypoints(
  entrypoints: readonly EntryPoint[], probe: EntryProbe = liveProbe,
): Promise<AuditionResult> {
  const out: AuditionResult = { entrypoints: [], rejected: [] };
  for (const entry of entrypoints) {
    if (!entry.unendorsed) {
      out.entrypoints.push(entry);
      continue;
    }
    const { keep, why } = auditionVerdict(await probe(entry.url.replace("{page}", "1")));
    audit("capability", `przesłuchanie entrypointu ${entry.url}: ${keep ? "zostaje" : "odrzucony"} — ${why}`,
      { url: entry.url, keep });
    if (keep) out.entrypoints.push(entry);
    else out.rejected.push({ url: entry.url, why });
  }
  return out;
}
