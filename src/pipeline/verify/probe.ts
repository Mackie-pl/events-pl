/** Sprawdzenie, czy adres źródła jeszcze żyje — jedno żądanie z pełnym opisem odpowiedzi. */
import { BROWSER_HEADERS, fetchUrl } from "../../adapters/http.js";
import { describeError } from "../../shared/errors.js";
import { urlKey } from "../../shared/url.js";
import type { FetchProbe } from "../../types/index.js";

/** Poniżej tego progu odpowiedź traktujemy jako zaślepkę/błąd, nie treść. */
export const MIN_BODY_CHARS = 500;

/**
 * Pobrania HTTP przy weryfikacji URL-i (każde źródło + kandydaci przy naprawie).
 * Licznik modułowy, bo do costs.json trafia wolumen CAŁEGO przebiegu jako kategoria `scrape`.
 * Świadomie osobny od liczników w innych adapterach: jeden wspólny wliczyłby do „scrape"
 * wywołania OpenRoutera, Supabase i Telegrama, czyli zafałszował rachunek.
 */
let verifyFetches = 0;

export const probeStats = (): number => verifyFetches;
export function resetProbeStats(): void { verifyFetches = 0; }

/**
 * Doliczenie pobrania wykonanego poza `probeUrl` — rozpoznanie entrypointów ściąga po kilka
 * stron na źródło i bez tego cały ten wolumen znikałby z kategorii `scrape` w księdze kosztów.
 */
export function countFetch(): void { verifyFetches += 1; }

/**
 * Jedno żądanie z pełnym opisem odpowiedzi. Sam kod statusu nie diagnozuje: 200 z 300 bajtami
 * to zaślepka, a 200 pod innym adresem niż pytany to przekierowanie na stronę główną
 * (czyli podstrona z wydarzeniami zniknęła, choć URL „działa").
 */
export async function probeUrl(url: string): Promise<FetchProbe> {
  const t0 = performance.now();
  verifyFetches += 1;
  const probe: FetchProbe = { at: new Date().toISOString(), url, ok: false, ms: 0 };
  try {
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 20_000);
    probe.httpStatus = res.status;
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim();
    if (ct) probe.contentType = ct;
    if (res.url && urlKey(res.url) !== urlKey(url)) probe.finalUrl = res.url;
    if (!res.ok) {
      probe.err = `HTTP ${res.status}`;
      return probe;
    }
    const text = await res.text();
    probe.chars = text.length;
    if (text.length < MIN_BODY_CHARS) {
      probe.err = `podejrzanie krótka odpowiedź (${text.length} B)`;
      return probe;
    }
    probe.ok = true;
    return probe;
  } catch (e) {
    probe.err = describeError(e);
    return probe;
  } finally {
    probe.ms = Math.round(performance.now() - t0);
  }
}
