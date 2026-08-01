/**
 * Adres, którym etap 2 wchodzi po wydarzenia.
 *
 * `Source.url` to KORZEŃ serwisu — klucz dedupe rejestru i nośnik proweniencji, nie miejsce,
 * w którym stoją wydarzenia. Etap 1 ustala to drugie i zapisuje jako `entrypoints`; do lipca
 * 2026 etap 2 tego pola nie czytał i codziennie pobierał stronę główną. Model dostawał menu
 * i newsletter zamiast listy imprez, więc 19 z 46 źródeł oddawało zero wydarzeń — osiem z nich
 * przy zapisanej liście z dziesiątkami odnośników (lubon-city ×63, poznan-kultura ×50).
 *
 * Wybór, a nie suma wszystkich entrypointów: w rejestrze każde źródło ma ich najwyżej jeden,
 * a pobieranie kilku list na źródło to inna decyzja (koszt × liczba stron) i zasługuje na
 * własną zmianę. Kolejność `listing → feed → api` odpowiada temu, jak dobrze treść nadaje
 * się do czytania przez model: `api` jest tu ostatnie, bo od maszynowych wyjść jest
 * `capabilities` i osobna ścieżka bez modelu.
 */
import { isFbFetch } from "../../shared/url.js";
import type { EntryPoint, Source } from "../../types/index.js";

const KIND_RANK: Record<EntryPoint["kind"], number> = { listing: 0, feed: 1, api: 2 };

/** Lepszy z dwóch entrypointów: najpierw rodzaj treści, potem pewność rozpoznania. */
const better = (a: EntryPoint, b: EntryPoint): EntryPoint => {
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] < KIND_RANK[b.kind] ? a : b;
  return a.confidence >= b.confidence ? a : b;
};

export interface Entry {
  /** adres do pobrania, z podstawioną paginacją */
  url: string;
  /** wybrany entrypoint — brak znaczy „wchodzimy korzeniem serwisu" */
  entrypoint?: EntryPoint;
}

/**
 * Adres wejścia dla tego źródła. Dla FB zawsze `Source.url`: tamta ścieżka idzie przez
 * Bright Data i nie pobiera stron HTTP-em, więc entrypoint tylko by ją rozstroił.
 */
export function entryUrl(src: Source): Entry {
  const page = (u: string): string => u.replace("{page}", "1");
  if (isFbFetch(src.fetch)) return { url: page(src.url) };

  const best = (src.entrypoints ?? []).reduce<EntryPoint | null>(
    (acc, e) => (acc ? better(acc, e) : e), null,
  );
  if (!best) return { url: page(src.url) };
  return { url: page(best.url), entrypoint: best };
}
