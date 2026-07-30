/**
 * Zwijanie adresów do szablonów i szukanie w nich list.
 *
 * Sedno rozpoznania etapu 1 i — docelowo — harvestu w etapie 2: strona z wydarzeniami nie
 * zdradza się znacznikami (na 15 przebadanych serwisów: zero JSON-LD `Event`, zero
 * `<time datetime>`, zero microdanych), ale ZDRADZA SIĘ POWTARZALNOŚCIĄ ADRESÓW. Lista, która
 * prowadzi do dziesięciu wydarzeń, ma dziesięć odnośników o tym samym kształcie ścieżki:
 *
 *   /wydarzenia/14696-frania-piorun-…/  →  /wydarzenia/{slug}   (ckzamek.pl)
 *   /event/checki-koncert-plenerowy/    →  /event/{slug}        (estrada.poznan.pl)
 *   /wydarzenia/dozynki-wiorka-…       →  /wydarzenia/{slug}   (mosina.pl)
 *
 * Moduł jest czystą arytmetyką na adresach (bez sieci i bez HTML-a), żeby dało się go
 * testować na zapisanych listach linków.
 */

/** Slot w szablonie — wartość zmienna, po której odróżniamy „to samo miejsce" od „ten sam wpis". */
const ID = "{id}";
const DATE = "{date}";
const SLUG = "{slug}";
const PAGE = "{page}";

/** Segmenty paginacji: /page/2, /strona/3 — numer po nich to numer strony, nie identyfikator wpisu. */
const PAGE_SEGMENTS = new Set(["page", "strona", "pg"]);
/** Parametry paginacji w query stringu. */
const PAGE_PARAMS = new Set(["page", "p", "strona", "pg", "start", "offset"]);

/**
 * Czy segment ścieżki jest wartością (identyfikatorem wpisu), czy nazwą działu.
 *
 * Próg 10 znaków dla slugów jest kompromisem wyznaczonym na żywych adresach: krótsze
 * człony z myślnikiem to prawie zawsze dział („co-robimy", „dla-dzieci"), dłuższe prawie
 * zawsze tytuł wpisu. Pomyłka w jedną stronę rozbija grupę na dwie, w drugą — skleja dwa
 * działy; obie są wykrywalne po liczebności grupy, więc dokładność ma tu wartość malejącą.
 */
const SEGMENT_SLOTS: ReadonlyArray<[(stem: string) => boolean, string]> = [
  [(s) => /^\d{4}-\d{2}-\d{2}$/.test(s), DATE],
  [(s) => /^\d+$/.test(s), ID],
  [(s) => s.includes("-") && (s.length >= 10 || /\d/.test(s)), SLUG],
  [(s) => s.length >= 24, SLUG],
];

function slotFor(segment: string): string | null {
  const [, stem = segment, ext = ""] = /^(.*?)(\.[a-z0-9]{2,5})?$/i.exec(segment) ?? [];
  if (!stem) return null;
  const slot = SEGMENT_SLOTS.find(([matches]) => matches(stem))?.[1];
  return slot === undefined ? null : slot + ext;
}

/**
 * Szablon adresu: ścieżka z wartościami zamienionymi na sloty, plus klucze parametrów.
 * Wartości parametrów pomijamy (poza paginacją), bo `?id=7` i `?id=8` to ten sam kształt.
 */
export function urlTemplate(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const segments = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const path = segments.map((seg, i) => {
    const prev = segments[i - 1]?.toLowerCase();
    if (prev && PAGE_SEGMENTS.has(prev) && /^\d+$/.test(seg)) return PAGE;
    return slotFor(decodeURIComponent(seg).toLowerCase()) ?? seg.toLowerCase();
  });
  const params = [...u.searchParams.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => (PAGE_PARAMS.has(k.toLowerCase()) ? `${k}=${PAGE}` : `${k}=${u.searchParams.get(k) ?? ""}`))
    .join("&");
  return `/${path.join("/")}${params ? `?${params}` : ""}`;
}

/** Liczba slotów w szablonie — szablon bez slotu to pojedyncza strona, nie wpis z listy. */
const slotCount = (template: string): number =>
  (template.match(/\{(?:id|slug|date)\}/g) ?? []).length;

/** Segmenty dosłowne przed pierwszym slotem — „/wydarzenia/{slug}" jest mocniejsze niż „/{slug}". */
function literalDepth(template: string): number {
  const segments = template.split("?")[0]?.split("/").filter(Boolean) ?? [];
  let n = 0;
  for (const s of segments) {
    if (s.startsWith("{")) break;
    n++;
  }
  return n;
}

export interface TemplateGroup {
  template: string;
  urls: string[];
  /** ile segmentów dosłownych poprzedza pierwszy slot */
  literalDepth: number;
  /** udział odnośników spoza nawigacji (0–1) — lista wpisów mieszka w treści, nie w menu */
  contentRatio: number;
  /** wynik rankingu; patrz `score` */
  score: number;
}

/** Segmenty dosłowne szablonu (przed pierwszym slotem) — „adres działu", w którym leżą wpisy. */
const literalPrefix = (template: string): string[] => {
  const segments = template.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const at = segments.findIndex((s) => s.startsWith("{"));
  return (at === -1 ? segments : segments.slice(0, at)).map((s) => s.replace(/\.[a-z0-9]{2,5}$/i, ""));
};

/**
 * Czy wpisy leżą „pod" stroną, z której zebraliśmy odnośniki. Najmocniejszy dostępny sygnał
 * i zarazem najtańszy: lista pod /wydarzenia prowadzi do /wydarzenia/<coś>. Bez niego
 * przegrywa z nawigacją całego serwisu — na gokkomorniki.pl płaskie `/{slug}.html` ma
 * 106 odnośników, a prawdziwa lista `/aktualnosci/{slug}` dziewięć.
 */
function pathAffinity(template: string, basePath: string | undefined): number {
  if (!basePath) return 1;
  const base = basePath.split("/").filter(Boolean).map((s) => s.replace(/\.[a-z0-9]{2,5}$/i, "").toLowerCase());
  const prefix = literalPrefix(template).map((s) => s.toLowerCase());
  if (!prefix.length || !base.length) return 1;
  const shared = prefix.filter((s, i) => base[i] === s).length;
  return shared === Math.min(prefix.length, base.length) ? 2.2 : 1;
}

/**
 * Wiarygodność grupy jako „lista wpisów". Sama liczebność nie wystarcza i to nie jest
 * teoretyczne zastrzeżenie — na trzech z sześciu przebadanych serwisów najliczniejsza grupa
 * była nawigacją albo kalendarzem:
 *
 * - liczebność wchodzi LOGARYTMICZNIE: sto odnośników w menu nie może przebić dziewięciu
 *   we właściwym miejscu, a bez tłumienia przebijało dwunastokrotnie.
 * - `contentRatio` odsiewa menu: 56 odnośników `/{slug}` na mosina.pl to stopka i menu boczne,
 *   a dziewięć `/wydarzenia/{slug}` to prawdziwa lista.
 * - kara dla `{date}` odsiewa kalendarze: kultura.poznan.pl ma 33 odnośniki
 *   `/mim/kultura/events/{date}` (widok dnia) i 20 `/mim/kultura/events/{slug}.html`
 *   (faktyczne wydarzenia). Bez kary wygrywał widok dnia.
 * - `literalDepth` premiuje `/wydarzenia/{slug}` nad `/{slug}`, ale już go nie dyskwalifikuje:
 *   WordPress z ładnymi odnośnikami trzyma wpisy dokładnie pod `/{slug}`.
 */
function score(g: Omit<TemplateGroup, "score">, basePath?: string): number {
  const onlyDate = g.template.includes(DATE) && !/\{(?:id|slug)\}/.test(g.template);
  return Math.log2(1 + g.urls.length)
    * (0.35 + 0.65 * g.contentRatio)
    * (g.literalDepth >= 1 ? 1 : 0.55)
    * (onlyDate ? 0.4 : 1)
    * pathAffinity(g.template, basePath);
}

/**
 * Adresy zwinięte do szablonów, posortowane wg wiarygodności „to jest lista wpisów".
 * `basePath` to ścieżka strony, z której pochodzą odnośniki — patrz `pathAffinity`.
 */
export function groupByTemplate(links: readonly TemplateInput[], basePath?: string): TemplateGroup[] {
  const byTemplate = new Map<string, Map<string, boolean>>();
  for (const link of links) {
    const url = typeof link === "string" ? link : link.url;
    const inNav = typeof link === "string" ? false : (link.inNav ?? false);
    const t = urlTemplate(url);
    const bucket = byTemplate.get(t) ?? new Map<string, boolean>();
    // ten sam adres w menu i w treści liczy się jako treść
    bucket.set(url, (bucket.get(url) ?? true) && inNav);
    byTemplate.set(t, bucket);
  }
  return [...byTemplate.entries()]
    .map(([template, bucket]) => {
      const urls = [...bucket.keys()];
      const outside = [...bucket.values()].filter((nav) => !nav).length;
      const base = {
        template, urls, literalDepth: literalDepth(template),
        contentRatio: urls.length ? outside / urls.length : 0,
      };
      return { ...base, score: score(base, basePath) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Wejście grupowania: sam adres albo odnośnik z informacją o nawigacji. */
export type TemplateInput = string | { url: string; inNav?: boolean };

/** Minimalna liczebność grupy, żeby uznać ją za listę, a nie zbieg okoliczności. */
export const MIN_GROUP = 3;

/** Najlepszy kandydat na „szablon strony pojedynczego wydarzenia" wśród odnośników strony. */
export function detailGroup(links: readonly TemplateInput[], basePath?: string): TemplateGroup | null {
  const groups = groupByTemplate(links, basePath).filter(
    (g) => g.urls.length >= MIN_GROUP && slotCount(g.template) >= 1,
  );
  return groups[0] ?? null;
}

/**
 * Czy wśród adresów widać paginację i jak wygląda jej adres.
 * Zwraca adres z podstawionym `{page}` — tym samym placeholderem, którego używa `Source.url`.
 */
export function detectPagination(urls: readonly string[]): string | null {
  for (const url of urls) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    for (const [key, value] of u.searchParams.entries()) {
      if (PAGE_PARAMS.has(key.toLowerCase()) && /^\d+$/.test(value)) {
        u.searchParams.set(key, PAGE);
        return decodeURIComponent(u.toString());
      }
    }
    const segments = u.pathname.split("/").filter(Boolean);
    const at = segments.findIndex((s, i) => i > 0 && /^\d+$/.test(s) && PAGE_SEGMENTS.has(segments[i - 1]?.toLowerCase() ?? ""));
    if (at !== -1) {
      segments[at] = PAGE;
      u.pathname = `/${segments.join("/")}`;
      return decodeURIComponent(u.toString());
    }
  }
  return null;
}
