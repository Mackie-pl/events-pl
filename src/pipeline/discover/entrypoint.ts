/**
 * Rozwiązanie entrypointu: pod jakim adresem serwis WYPISUJE wydarzenia.
 *
 * Powód istnienia tego pliku: rejestr trzymał wyłącznie korzeń serwisu, więc codzienny
 * przebieg wchodził przez `mycity.pl` i podawał modelowi menu, newsletter i baner cookies —
 * podczas gdy lista siedziała pod stałym `mycity.pl/aktualnosci`. Adres jest stały, a szukanie
 * go co rano kosztowało tokeny i tak czy owak kończyło się gorszym wejściem.
 *
 * Kolejność jest celowa — od najtańszego do najdroższego:
 *   1. odnośniki z korzenia, punktowane po ścieżce i tekście kotwicy   (0 żądań ponad to jedno)
 *   2. pobranie kilku najlepszych i zmierzenie ich GĘSTOŚCIĄ LISTY     (kilka żądań)
 *   3. jedno tanie wywołanie modelu, które rozstrzyga i może zawetować (~$0.001)
 */
import { convert as htmlToText } from "html-to-text";

import { BROWSER_HEADERS, fetchUrl } from "../../adapters/http.js";
import { MODEL_EXTRACT, chat } from "../../adapters/openrouter.js";
import { extractLinks, type PageLink } from "../../shared/links.js";
import { str, trim } from "../../shared/text.js";
import { MIN_GROUP, detailGroup, detectPagination, groupByTemplate } from "../../shared/url-template.js";
import type { EntryPoint, Source } from "../../types/index.js";
import { countFetch } from "../verify/probe.js";
import { ENTRYPOINT_SYSTEM } from "../prompts.js";

/** Ile kandydatów pobieramy, żeby zmierzyć je gęstością listy. */
const MAX_CANDIDATES = 5;
/** Próbka tekstu strony dla modelu — tyle wystarcza, żeby odróżnić wydarzenia od przetargów. */
const SAMPLE_CHARS = 1_200;

/**
 * Ścieżki i teksty kotwic, pod którymi polskie instytucje trzymają wydarzenia.
 * `event` jest tu mimo polskiego kontekstu, bo motywy WordPressa robią `/event/` i `/events/`
 * niezależnie od języka serwisu — estrada.poznan.pl wypisuje tak cały repertuar.
 */
const GOOD = /(wydarzeni|aktualnosc|aktualnoś|kalendar|imprez|repertuar|afisz|program|co-gdzie-kiedy|kultura|event)/i;
/** Miejsca, które wyglądają podobnie, a wydarzeń nie wypisują. */
const BAD = /(archiw|relacj|galeri|przetarg|bip|zamowien|nabor|rodo|polityka|regulamin|cennik|kontakt|\/20\d\d\b|\.pdf$)/i;

export interface Candidate {
  url: string;
  /** punkty z heurystyki adresowej (krok 1) */
  hint: number;
  /** wynik gęstości listy po pobraniu (krok 2); brak = strony nie pobrano */
  score?: number;
  detailPattern?: string;
  detailCount?: number;
  pagination?: string;
  sample?: string;
}

/** Ścieżka odnośnika w postaci porównywalnej z wzorcami; null = adres nie do rozłożenia. */
function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + u.search).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Punkty odnośnika jako kandydata na listę wydarzeń. 0 = nie bierzemy pod uwagę.
 *
 * Obecność w menu jest wyłącznie PREMIĄ, nigdy biletem wstępu. Gdy sama kwalifikowała
 * kandydata, do stawki wchodziła cała nawigacja serwisu i wygrywał ten dział, który miał
 * najgęstszą listę czegokolwiek: na estrada.poznan.pl były to „ogłoszenia" (24 odnośniki),
 * a repertuar pod /event/ w ogóle nie startował.
 */
function hintFor(link: PageLink, path: string): number {
  if (BAD.test(path)) return 0;
  const base = (GOOD.test(path) ? 3 : 0) + (GOOD.test(link.text) ? 2 : 0);
  if (base === 0) return 0;
  // bardzo głęboka ścieżka to raczej konkretny wpis niż lista
  const deep = path.split("/").filter(Boolean).length > 3 ? 1 : 0;
  return Math.max(base + (link.inNav ? 1 : 0) - deep, 0);
}

/**
 * Adresy, które są WPISEM, a nie działem — rozpoznane po tym, że mają na tej samej stronie
 * rodzeństwo o identycznym kształcie.
 *
 * Dział serwisu występuje w nawigacji raz („/wydarzenia"), a pojedyncze wydarzenie stoi obok
 * dziewięciu sąsiadów („/event/koncert-a", „/event/koncert-b", …). Bez tego filtra heurystyka
 * na estrada.poznan.pl wybierała stronę JEDNEGO koncertu zamiast repertuaru — formalnie
 * pasowała do wzorca `/event/` i miała gęste odnośniki „powiązanych".
 */
function itemUrls(links: readonly PageLink[]): Set<string> {
  const items = new Set<string>();
  for (const group of groupByTemplate(links)) {
    if (group.urls.length < MIN_GROUP || !/\{(?:id|slug|date)\}/.test(group.template)) continue;
    for (const url of group.urls) items.add(url);
  }
  return items;
}

/** Kandydaci z samych odnośników korzenia — bez ani jednego dodatkowego żądania. */
export function rankLinks(links: readonly PageLink[], rootUrl: string): Candidate[] {
  const items = itemUrls(links);
  const byUrl = new Map<string, number>();
  for (const link of links) {
    const path = pathOf(link.url);
    if (path === null || items.has(link.url)) continue;
    const hint = hintFor(link, path);
    if (hint <= 0) continue;
    byUrl.set(link.url, Math.max(byUrl.get(link.url) ?? 0, hint));
  }
  // sam korzeń zostaje w stawce: część małych serwisów wypisuje wydarzenia wprost na stronie głównej
  if (!byUrl.has(rootUrl)) byUrl.set(rootUrl, 1);
  return [...byUrl.entries()]
    .map(([url, hint]) => ({ url, hint }))
    .sort((a, b) => b.hint - a.hint);
}

/**
 * Pobranie kandydata i zmierzenie go gęstością listy — czy naprawdę prowadzi do wpisów.
 *
 * Bierzemy SUROWY HTML, nie `fetchPlain`: do grupowania potrzebne są adresy odnośników wraz
 * z informacją, czy siedzą w nawigacji, a `html-to-text` gubi jedno i drugie. Próbkę tekstu
 * dla modelu robimy z tego samego pobrania — jedno źródło, jedno żądanie.
 */
export async function measure(candidate: Candidate): Promise<Candidate> {
  const raw = await rawHtml(candidate.url);
  if (raw === null) return candidate;
  const links = extractLinks(raw, candidate.url);
  const group = detailGroup(links, new URL(candidate.url).pathname);
  const pagination = detectPagination(links.map((l) => l.url));
  return {
    ...candidate,
    score: group?.score ?? 0,
    sample: htmlToText(raw, { wordwrap: false, selectors: TEXT_SELECTORS })
      .replace(/\s+/g, " ").slice(0, SAMPLE_CHARS),
    ...(group ? { detailPattern: group.template, detailCount: group.urls.length } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

/** Ten sam zestaw co w page-fetch: menu i stopka to szum, którego model nie ma po co czytać. */
const TEXT_SELECTORS = [
  { selector: "nav", format: "skip" },
  { selector: "script", format: "skip" },
  { selector: "style", format: "skip" },
  { selector: "footer", format: "skip" },
];

async function rawHtml(url: string): Promise<string | null> {
  try {
    countFetch();
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 20_000);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export interface EntrypointVerdict {
  entrypoints: EntryPoint[];
  verdict?: "events" | "news" | "none";
  why?: string;
}

/**
 * Jedno wywołanie modelu na źródło: kandydaci + dowody → wybrany adres albo weto.
 * Wyłączane `ENTRYPOINT_LLM=ambiguous` (wtedy pytamy tylko przy remisie) — patrz `resolveEntrypoints`.
 */
async function adjudicate(src: Source, candidates: readonly Candidate[]): Promise<EntrypointVerdict | null> {
  const shown = candidates.slice(0, MAX_CANDIDATES).map((c) => ({
    url: c.url,
    odnosnikow: c.detailCount ?? 0,
    szablon: c.detailPattern ?? null,
    tekst: trim(c.sample ?? "", SAMPLE_CHARS),
  }));
  const out = await chat({
    model: MODEL_EXTRACT,
    task: "verify",
    system: ENTRYPOINT_SYSTEM,
    user: `Instytucja: ${src.name} (${src.town})\nKandydaci:\n${JSON.stringify(shown)}`,
    maxTokens: 300,
  });
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { url?: unknown; verdict?: unknown; why?: unknown };
    const verdict = parsed.verdict === "events" || parsed.verdict === "news" || parsed.verdict === "none"
      ? parsed.verdict
      : undefined;
    const url = str(parsed.url);
    const picked = candidates.find((c) => c.url === url);
    const why = str(parsed.why);
    return {
      entrypoints: picked && verdict !== "none" ? [toEntryPoint(picked, "llm", 0.9)] : [],
      ...(verdict ? { verdict } : {}),
      ...(why ? { why } : {}),
    };
  } catch {
    return null;
  }
}

function toEntryPoint(c: Candidate, via: EntryPoint["via"], confidence: number): EntryPoint {
  return {
    url: c.pagination ?? c.url,
    kind: "listing",
    confidence,
    via,
    ...(c.detailPattern ? { detailPattern: c.detailPattern } : {}),
    ...(c.detailCount !== undefined ? { detailCount: c.detailCount } : {}),
    ...(c.pagination ? { paginated: true } : {}),
  };
}

/**
 * Wynik gęstości, powyżej którego heurystyka jest sama w sobie przekonująca.
 * Skalibrowane na żywych serwisach: pewne trafienia dawały 6,9–8,6 (mosina.pl/wydarzenia,
 * gokkomorniki.pl/aktualnosci), a serwisy o płaskiej strukturze bez wyraźnej listy — 1,4–1,7.
 */
const CONFIDENT = 4;

const scoreOf = (c: Candidate | undefined): number => c?.score ?? 0;

/**
 * Czy heurystyka rozstrzygnęła sama. „Niejednoznaczne" to albo słaby najlepszy wynik,
 * albo remis — dwaj czołowi kandydaci w granicy punktu od siebie.
 */
function needsModel(measured: readonly Candidate[]): boolean {
  const mode = (process.env["ENTRYPOINT_LLM"] ?? "always").toLowerCase();
  if (mode === "never") return false;
  if (mode !== "ambiguous") return true;
  const [best, runner] = measured;
  return !best || scoreOf(best) < CONFIDENT || (runner !== undefined && scoreOf(best) - scoreOf(runner) < 1);
}

/** Rozpoznanie entrypointów źródła. `html` to surowa treść korzenia (już pobrana przy drabinie). */
export async function resolveEntrypoints(
  src: Source, rootUrl: string, html: string,
): Promise<EntrypointVerdict> {
  const ranked = rankLinks(extractLinks(html, rootUrl), rootUrl).slice(0, MAX_CANDIDATES);
  const measured: Candidate[] = [];
  for (const c of ranked) measured.push(await measure(c));
  measured.sort((a, b) => scoreOf(b) - scoreOf(a) || b.hint - a.hint);

  const best = measured[0];
  const heuristic = best && scoreOf(best) > 0 ? [toEntryPoint(best, "heuristic", 0.6)] : [];
  if (!needsModel(measured)) return { entrypoints: heuristic };

  const judged = await adjudicate(src, measured);
  if (!judged) return { entrypoints: heuristic };
  // model widział te same strony co heurystyka — gdy nic nie wybrał, ale nie zawetował,
  // zostaje wynik pomiaru; „none" jest jedyną odpowiedzią, która kasuje kandydatów
  if (judged.verdict === "none") return judged;
  return { ...judged, entrypoints: judged.entrypoints.length ? judged.entrypoints : heuristic };
}
