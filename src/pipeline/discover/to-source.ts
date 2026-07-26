/** Walidacja rekordu od LLM → Source. */
import { slug, str, trim } from "../../shared/text.js";
import { normalizeFbGroupUrl } from "../../shared/url.js";
import type { FetchStrategy, Source, SourceType } from "../../types/index.js";

const SOURCE_TYPES = new Set<string>([
  "city_portal", "culture_center", "library", "sports", "venue",
  "fb_page", "fb_group", "rss", "api", "pdf_program",
]);
const FETCH_STRATEGIES = new Set<string>([
  "plain", "headless", "pdf", "api", "fb", "fb_group", "fb_event", "rss",
]);

/** Model bywa oszczędny: „gok.pl" zamiast pełnego adresu. Doklejamy schemat, ale śmieci odrzucamy. */
function normalizeProposedUrl(raw: unknown): { url: string; fixes: string[] } | { err: string } {
  let url = str(raw);
  if (!url) return { err: "brak pola url" };
  const fixes: string[] = [];
  if (!/^https?:\/\//i.test(url)) {
    if (!/^[\w.-]+\.[a-z]{2,}/i.test(url)) {
      return { err: `url nie jest adresem http(s): ${trim(url, 80)}` };
    }
    url = `https://${url}`;
    fixes.push("dodano schemat https://");
  }
  try {
    // {page} to nasz placeholder paginacji — do walidacji podstawiamy cokolwiek
    new URL(url.replace("{page}", "1"));
  } catch {
    return { err: `url nie do sparsowania: ${trim(url, 80)}` };
  }
  return { url, fixes };
}

/**
 * Adresy FB wymuszają strategię pobierania niezależnie od tego, co powiedział model:
 * zwykły fetch dostaje login-wall, a nie treść.
 */
function normalizeFbFields(
  url: string,
  fetchStrategy: string,
  type: string,
): { url: string; fetch: string; type: string; fixes: string[] } {
  const fixes: string[] = [];
  if (/facebook\.com\/groups\//i.test(url)) {
    const rooted = normalizeFbGroupUrl(url);
    if (rooted !== url) { url = rooted; fixes.push("URL grupy skrócony do korzenia"); }
    if (fetchStrategy !== "fb_group") {
      fetchStrategy = "fb_group";
      fixes.push('fetch → "fb_group" (URL grupy FB)');
    }
    if (type !== "fb_group") { type = "fb_group"; fixes.push('type → "fb_group"'); }
  } else if (/^https?:\/\/(?:www\.)?facebook\.com\//i.test(url) && fetchStrategy !== "fb") {
    fetchStrategy = "fb";
    fixes.push('fetch → "fb" (adres facebook.com)');
  }
  if (!FETCH_STRATEGIES.has(fetchStrategy)) {
    fixes.push(`nieznane fetch "${trim(fetchStrategy, 30)}" → "plain"`);
    fetchStrategy = "plain";
  }
  if (!SOURCE_TYPES.has(type)) {
    fixes.push(`nieznany type "${trim(type, 30)}" → "venue"`);
    type = "venue";
  }
  return { url, fetch: fetchStrategy, type, fixes };
}

/**
 * Rekord od LLM → Source. Odpowiedź modelu jest rzutowana, nie walidowana (`as Source[]`
 * w poprzedniej wersji), a wchodzi wprost do rejestru czytanego codziennie przez daily.
 * Brak `id` albo dwa źródła o tym samym `id` cicho scalają cache ekstrakcji w state.json.
 */
export function toSource(raw: unknown, town: string): { src: Source; fixes: string[] } | { err: string } {
  if (typeof raw !== "object" || raw === null) return { err: "rekord nie jest obiektem" };
  const r = raw as Record<string, unknown>;

  const parsed = normalizeProposedUrl(r["url"]);
  if ("err" in parsed) return parsed;

  const name = str(r["name"]);
  if (!name) return { err: "brak pola name" };

  const fb = normalizeFbFields(parsed.url, str(r["fetch"]) ?? "", str(r["type"]) ?? "");

  const id = slug(str(r["id"]) ?? `${town}-${name}`);
  if (!id) return { err: "nie da się zbudować id" };

  const confidence = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"])
    ? Math.max(0, Math.min(1, r["confidence"]))
    : undefined;
  const notes = str(r["notes"]);

  const src: Source = {
    id,
    name,
    type: fb.type as SourceType,
    url: fb.url,
    town: str(r["town"]) ?? town,
    fetch: fb.fetch as FetchStrategy,
    verified: false,
    discovered: "auto",
    ...(confidence !== undefined ? { confidence } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  return { src, fixes: [...parsed.fixes, ...fb.fixes] };
}
