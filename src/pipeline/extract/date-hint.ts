/**
 * Ostatni bezpiecznik na datę WYMYŚLONĄ przez model.
 *
 * Prompt mówi „BEZ DATY = NIE WYDARZENIE", ale to prośba, nie kontrakt — a model ma w systemie
 * zdanie „Dziś jest YYYY-MM-DD" i przy tekście bez terminu sięga po nie jak po domyślną wartość.
 * Zmierzone na `fb-group-imprezy-poznan` (2026-08-12, wywołanie 0041): z 31 wydarzeń cztery
 * dostały `date_start` = dzień przebiegu i `time_start: null`, a trzy z nich stały w postach,
 * w których nie ma ani jednej daty. Tak powstał „Wieczór Grecki" z datą 12 sierpnia zamiast 21.
 *
 * Reguła jest jedna i deterministyczna: jeśli w treści, z której wydarzenie pochodzi, NIE MA
 * niczego, co wyznacza termin, to każda data jest zgadywaniem — wpis odpada. `repeat` z drutu
 * jest wyjątkiem: rytm („w każdy czwartek") daty nie zawiera, a mimo to je wyznacza (shared/series.ts).
 *
 * DLACZEGO NIE „data == dziś": bo to warunek zależny od dnia przebiegu, a wynik ekstrakcji idzie
 * prosto do cache'a kluczowanego hashem TREŚCI (patrz nagłówek extract.ts). Warunek liczony
 * wyłącznie z treści zapisuje się do cache'a raz i nie zmienia zdania jutro.
 */
import { audit } from "../../shared/audit.js";
import type { EventItem } from "../../types/index.js";

/**
 * Cokolwiek, co wyznacza termin — także mgliście („w sobotę", „jutro"). Lista jest CELOWO
 * hojna: każde trafienie ZATRZYMUJE wydarzenie, więc nadmiarowy wzorzec kosztuje najwyżej
 * przepuszczenie jednego zmyślonego wpisu, a brakujący wzorzec kasuje prawdziwy.
 */
const MONTHS = "stycz|lut|marz|marc|kwiet|maj|czerw|lip|sierp|wrze|paździer|pazdzier|listopad|grud";
const WEEKDAYS = "poniedział|poniedzial|wtor|środ|srod|czwart|piąt|piat|sobot|niedziel";
const RELATIVE = "dziś|dzis|dzisiaj|jutro|pojutrze|weekend|codziennie|w każd|w kazd|najbliższ|najblizsz";

const HINTS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}/,                                  // 2026-08-21
  /\b\d{1,2}\s*[./-]\s*\d{1,2}\b/,                      // 21.08 · 21/08 · 21-08
  new RegExp(`\\b\\d{1,2}\\s*(?:${MONTHS})`, "i"),      // 21 sierpnia
  new RegExp(`\\b(?:${WEEKDAYS})`, "i"),
  new RegExp(`\\b(?:${RELATIVE})`, "i"),
];

/**
 * Dwa czyszczenia przed szukaniem, oba wymuszone przez materiał:
 *
 * NFKC, bo ogłoszenia na FB są pisane ozdobnymi wariantami znaków — „𝟏𝟓.𝟎𝟖, 17:00 – Spacer po
 * Trakcie" (fb-group-wydarzenia-w-poznaniu-1, 2026-08-12) niesie datę w matematycznych cyfrach
 * pogrubionych, których `\d` nie widzi. Model czyta je bez mrugnięcia, więc bez normalizacji
 * bezpiecznik kasowałby wydarzenia PRAWDZIWE: na przegraniu dnia 2026-08-12 dwa takie były.
 * Dwa to mało, ale to CAŁA klasa błędu — ozdobne znaki są u ogłoszeniodawców modą, nie wyjątkiem,
 * a każdy inny wzorzec w potoku jest na nie tak samo ślepy.
 *
 * Adresy do kosza, bo „/2026/08/13/" w permalinku wygląda jak termin, a jest datą publikacji —
 * dokładnie ta pomyłka, przed którą to wszystko ma bronić.
 */
const clean = (text: string): string => text.normalize("NFKC").replace(/https?:\/\/\S+/g, " ");

export const hasDateHint = (text: string): boolean =>
  HINTS.some((re) => re.test(clean(text)));

const normUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/**
 * Treść pojedynczego postu spod jego `LINK:` — bo tylko ona jest DOWODEM na to konkretne
 * wydarzenie. Blok bywa sklejką kilkunastu postów (na `imprezy-poznan` blok 1 to siedem
 * postów), więc data z sąsiada usprawiedliwiłaby wpis, do którego nie należy. Do tego model
 * potrafi podpisać wpis cudzym numerem bloku — wszystkie cztery wymyślone wydarzenia z pomiaru
 * przypisał do bloku 1, choć trzy z nich stały gdzie indziej. `source_url` przeżył tę pomyłkę,
 * numer bloku nie, więc dowód wiążemy adresem.
 *
 * Wiersze `DATA POSTU:` wypadają: to data PUBLIKACJI, nie termin wydarzenia. Zostawione
 * przepuszczałyby każdy post, bo każdy ma nagłówek z datą ISO.
 */
export function postsByLink(text: string): Map<string, string> {
  const clean = text
    .replace(/^DATA POSTU:.*$/gmu, "")
    .replace(/^BLOK \d+:$/gmu, "")
    .replace(/^ŹRÓDŁO:.*$/gmu, "");
  const out = new Map<string, string>();
  const parts = clean.split(/^LINK:[ \t]*(\S+)[ \t]*$/mu);
  // parts = [przed pierwszym LINK-iem, url1, treść1, url2, treść2, …]
  for (let i = 1; i < parts.length; i += 2) {
    const url = parts[i], body = parts[i + 1];
    if (url && body !== undefined) out.set(normUrl(url), body);
  }
  return out;
}

/**
 * Odsiew wydarzeń, których data nie ma oparcia w treści. Zwraca to, co zostaje; każdy odrzut
 * idzie do śladu z tytułem i datą, żeby fałszywe trafienie tego bezpiecznika dało się zobaczyć
 * w panelu, a nie tylko policzyć.
 *
 * `text` to CAŁOŚĆ wysłana do modelu. Dowodem jest post spod adresu wydarzenia, a gdy takiego
 * nie ma (zwykła strona, nie grupa FB) — cały tekst. Świadomie najszerzej, jak się da: bez
 * dowiązania po adresie nie wiadomo, z którego fragmentu wpis pochodzi, a bezpiecznik ma
 * strzelać do wymysłów, nie do wydarzeń stojących o akapit dalej.
 */
export function keepFoundedDates(events: EventItem[], text: string): EventItem[] {
  if (!events.length) return events;
  const posts = postsByLink(text);
  const wholeOk = hasDateHint(text);
  const kept: EventItem[] = [];
  for (const ev of events) {
    const post = posts.get(normUrl(ev.source_url ?? ""));
    const founded = ev.repeat ? true : (post !== undefined ? hasDateHint(post) : wholeOk);
    if (founded) { kept.push(ev); continue; }
    audit("event.dropped",
      `„${ev.title}" — data ${ev.date_start} nie ma oparcia w treści` +
      `${post !== undefined ? " postu" : ""}: nie ma tam ani terminu, ani rytmu`,
      { title: ev.title, date: ev.date_start, why: "data bez oparcia w treści",
        scope: post !== undefined ? "post" : "całość" });
  }
  return kept;
}
