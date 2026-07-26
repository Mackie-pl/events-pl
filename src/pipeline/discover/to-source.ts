/** Walidacja rekordu od LLM → Source. */
import { slug, str, trim } from "../../shared/text.js";
import { normalizeFbGroupUrl } from "../../shared/url.js";
import type { FetchStrategy, Source, SourceType } from "../../types/index.js";

const SOURCE_TYPES = new Set<string>([
  "city_portal", "culture_center", "library", "sports", "venue", "fb_page", "fb_group", "rss", "api", "pdf_program",
]);
const FETCH_STRATEGIES = new Set<string>(["plain", "headless", "pdf", "api", "fb", "fb_group", "fb_event", "rss"]);

/**
 * Rekord od LLM → Source. Odpowiedź modelu jest rzutowana, nie walidowana (`as Source[]`
 * w poprzedniej wersji), a wchodzi wprost do rejestru czytanego codziennie przez daily.ts.
 * Brak `id` albo dwa źródła o tym samym `id` cicho scalają cache ekstrakcji w state.json.
 */
export function toSource(raw: unknown, town: string): { src: Source; fixes: string[] } | { err: string } {
  if (typeof raw !== "object" || raw === null) return { err: "rekord nie jest obiektem" };
  const r = raw as Record<string, unknown>;
  const fixes: string[] = [];

  let url = str(r["url"]);
  if (!url) return { err: "brak pola url" };
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) {
      url = `https://${url}`;
      fixes.push("dodano schemat https://");
    } else {
      return { err: `url nie jest adresem http(s): ${trim(url, 80)}` };
    }
  }
  try {
    new URL(url.replace("{page}", "1"));
  } catch {
    return { err: `url nie do sparsowania: ${trim(url, 80)}` };
  }

  const name = str(r["name"]);
  if (!name) return { err: "brak pola name" };

  let fetchStrategy = str(r["fetch"]) ?? "";
  let type = str(r["type"]) ?? "";
  if (/facebook\.com\/groups\//i.test(url)) {
    const rooted = normalizeFbGroupUrl(url);
    if (rooted !== url) { url = rooted; fixes.push("URL grupy skrócony do korzenia"); }
    if (fetchStrategy !== "fb_group") { fetchStrategy = "fb_group"; fixes.push('fetch → "fb_group" (URL grupy FB)'); }
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

  const confidence = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"])
    ? Math.max(0, Math.min(1, r["confidence"]))
    : undefined;

  const id = slug(str(r["id"]) ?? `${town}-${name}`);
  if (!id) return { err: "nie da się zbudować id" };

  const notes = str(r["notes"]);
  const src: Source = {
    id,
    name,
    type: type as SourceType,
    url,
    town: str(r["town"]) ?? town,
    fetch: fetchStrategy as FetchStrategy,
    verified: false,
    discovered: "auto",
    ...(confidence !== undefined ? { confidence } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  return { src, fixes };
}
