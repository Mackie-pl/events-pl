/**
 * Followup dosłownie ze strony, a nie z pamięci modelu.
 *
 * Model dostaje tekst z odnośnikami TAKIMI, jakie stoją w HTML-u (`html-to-text` bez `baseUrl`,
 * patrz `adapters/page-fetch.ts`), a w JSON-ie oddaje adres bezwzględny — czyli sam skleja
 * domenę ze ścieżką. To sklejanie jest miejscem, w którym adres cicho przestaje istnieć.
 *
 * Przypadek z 2026-08-12, `mdk2.poznan.pl/aktualnosci.html`: strona linkuje
 * `/images/mdk2/rekrutacja_2026_2007/…`, a model oddał `https://mdk2.poznan.pl/images/mdk/…`
 * — „2" zostało zużyte na host i zniknęło ze ścieżki. Wszystkie TRZY PDF-y z tej strony straciły
 * tę samą cyfrę (literówkę serwisu w nazwie katalogu — `2007` zamiast `2027` — model przepisał
 * wiernie, więc to nie było zmyślanie, tylko sklejanie). Adresy wylądowały
 * w `state.followupsBySource`, a 404 nie zmienia hasha strony, więc wracały w KAŻDYM przebiegu:
 * 7 przebiegów × 3 adresy = 21 pobrań po nic, bez terminu końcowego.
 *
 * Stąd reguła: nie prosimy modelu o arytmetykę na stringach. Adres względny rozwijamy sami,
 * a wynik konfrontujemy z INWENTARZEM strony (`linkedUrls`). Asymetria błędu rozstrzyga, co
 * robić przy braku trafienia: adres z TEGO serwisu, którego na stronie nie ma, to prawie zawsze
 * przepisanie z błędem albo zgadywanie — i kosztuje 404 dziennie w nieskończoność; adres z obcej
 * domeny (plakat na CDN-ie, program u organizatora) inwentarzem sprawdzić się nie da, więc
 * przechodzi. Fail closed tam, gdzie mamy wyrocznię, i tylko tam.
 *
 * IDEMPOTENTNA — dokładnie z tego powodu, co `fetchable` w `process-source.ts`: wołamy ją i na
 * świeżych propozycjach modelu, i na liście odtworzonej ze `state`. Drugie wywołanie trafia same
 * adresy z inwentarza, więc nie dopisuje ani jednej notki do śladu. Ta druga droga LECZY stan:
 * zatrute wpisy sprzed tej zmiany naprawia najbliższy przebieg, w którym strona odda HTML.
 */
import { audit } from "../../shared/audit.js";
import { linkedUrls } from "../../shared/links.js";
import { host, urlKey } from "../../shared/url.js";

/** Ostatni segment ścieżki, zdekodowany — po nim poznajemy „ten sam plik, inna ścieżka". */
function fileOf(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return "";
  }
}

interface Inventory {
  /** `urlKey` → adres w postaci, w jakiej stoi na stronie */
  byKey: Map<string, string>;
  /** nazwa pliku → adres; `null` = nazwa niejednoznaczna, więc nie ma czego przyciągać */
  byFile: Map<string, string | null>;
}

function inventoryOf(html: string, pageUrl: string): Inventory {
  const byKey = new Map<string, string>();
  const byFile = new Map<string, string | null>();
  for (const u of linkedUrls(html, pageUrl)) {
    byKey.set(urlKey(u), u);
    const file = fileOf(u);
    if (!file) continue;
    const had = byFile.get(file);
    // dwa różne adresy o tej samej nazwie pliku: przyciąganie byłoby losowaniem
    if (had === undefined) byFile.set(file, u);
    else if (had !== null && urlKey(had) !== urlKey(u)) byFile.set(file, null);
  }
  return { byKey, byFile };
}

/** Jeden adres → adres do pobrania albo `null` (odrzucony, ślad już zapisany). */
function ground(raw: string, pageUrl: string, inv: Inventory | null): string | null {
  let abs: string;
  try {
    abs = new URL(raw, pageUrl).toString();
  } catch {
    audit("followup.url", "model podał coś, co nie jest adresem — nie ma czego pobierać", { url: raw });
    return null;
  }
  if (!inv) return abs; // PDF, feed, posty grupy FB — nie ma HTML-a, nie ma wyroczni

  const exact = inv.byKey.get(urlKey(abs));
  if (exact) return exact;

  const snapped = inv.byFile.get(fileOf(abs));
  if (snapped) {
    audit("followup.url", "adres od modelu rozjechał się ze stroną — bierzemy ten, który na niej stoi",
      { url: snapped, was: abs });
    return snapped;
  }
  if (host(abs) === host(pageUrl)) {
    audit("followup.url", "tego adresu nie ma na stronie, a udaje jej własny — nie pobieramy",
      { url: abs });
    return null;
  }
  return abs; // obca domena: inwentarz nie jest tu wyrocznią, więc nie zgrywamy sędziego
}

/**
 * Propozycje followupów sprowadzone do adresów, które strona naprawdę niesie.
 * `html` puste (PDF, feed, grupa FB) = brak wyroczni: adresy tylko rozwijamy względem strony.
 */
export function groundFollowups(proposed: string[], pageUrl: string, html?: string): string[] {
  const inv = html ? inventoryOf(html, pageUrl) : null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of proposed) {
    const url = ground(raw, pageUrl, inv);
    if (url === null) continue;
    const key = urlKey(url);
    if (seen.has(key)) continue; // przyciąganie potrafi skleić dwa zapisy w jeden adres
    seen.add(key);
    out.push(url);
  }
  return out;
}
