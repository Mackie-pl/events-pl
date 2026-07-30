/** Naprawa martwego URL-a: search po nazwie instytucji → propozycja taniego modelu. */
import { webSearch } from "../../adapters/search.js";
import { MODEL_EXTRACT, chat } from "../../adapters/openrouter.js";
import type { SearchResult, Source, SourceVerification } from "../../types/index.js";
import { REVERIFY_SYSTEM } from "../prompts.js";

/** Szuka aktualnego URL instytucji (wyszukiwarka + tani model). null = nie znaleziono. */
export async function findReplacementUrl(src: Source, ver: SourceVerification): Promise<string | null> {
  const results: SearchResult[] = [];
  for (const q of [`"${src.name}" ${src.town}`, `${src.name} ${src.town} wydarzenia`]) {
    results.push(...(await webSearch(q, ver.searches)));
  }
  if (results.length === 0) return null;
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "verify",
    system: REVERIFY_SYSTEM,
    user: `Instytucja: ${src.name} (${src.town})\nStary, martwy URL: ${src.url}\n` +
      `Wyniki wyszukiwania:\n${JSON.stringify(results)}`,
    maxTokens: 300,
  });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const url = (JSON.parse(m[0]) as { url?: string | null }).url;
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}
