/**
 * Drabinka zapytań do Nominatim: jak z pola `venue` zrobić coś, na co geokoder ODPOWIADA.
 *
 * Wydzielone z `nominatim.ts` 2026-08-21, kiedy tamten plik dobił do progu 350 linii przy
 * dokładaniu prostokąta regionu. Podział jest naturalny i przebiega po granicy sieci:
 * TU mieszka wyłącznie obróbka tekstu (czysta, testowalna bez sieci — patrz
 * `test/geo-queries.test.ts`), a tam samo pytanie, cache i werdykt.
 */

/**
 * Człony, które same z siebie nie są miejscem — „Sala kolumnowa", „Start", „Hala".
 * Bez tej listy drabinka pyta o nie pierwsza i dostaje ODPOWIEDŹ: w Poznaniu jest ulica
 * Start i budynek „Hala 2". Fałszywe trafienie jest gorsze niż brak — pinezka ląduje
 * kilometry od wydarzenia i nikt tego nie zauważy, bo `hit=true`.
 */
const GENERIC = new Set([
  "sala", "salka", "aula", "hala", "start", "meta", "zbiórka", "zbiorka", "parking",
  "wejście", "wejscie", "scena", "foyer", "świetlica", "swietlica", "budynek", "miejsce",
]);

/**
 * Odmiana: geokoder zna MIANOWNIK. „na placu Wolności" nie trafia, „plac Wolności" tak.
 * Tylko formy, które realnie wychodzą z prozy o miejscu zbiórki.
 */
const CASES: Record<string, string> = {
  placu: "plac", parku: "park", rynku: "rynek", skwerze: "skwer",
  osiedlu: "osiedle", alei: "aleja", dworcu: "dworzec", moście: "most",
};

/**
 * Wyrazy z małej litery, które ZACZYNAJĄ nazwę miejsca, a nie są prozą przed nią.
 * Bez nich obcinacz prozy zjada „os." z „os. Lecha 43" i „park" z „park Wilsona".
 */
const STARTS = new Set([
  ...Object.keys(CASES), ...Object.values(CASES),
  "ul", "ul.", "ulica", "al", "al.", "aleja", "aleje", "os", "os.", "osiedle",
  "pl", "pl.", "plac", "park", "rynek", "skwer", "bulwar", "las", "lasek",
]);

/** Bez diakrytyków i z małej litery — wspólny mianownik porównań, także w `nominatim.ts`. */
export const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Obcina prozę OTACZAJĄCĄ nazwę: etykietę z przodu, dopowiedzenie i przyimki z tyłu. */
function trimProse(raw: string): string {
  return raw
    .replace(/\s+/g, " ").trim()
    // „Start: przy fontannie…", „Miejsce: …" — etykieta, nie nazwa
    .replace(/^[\p{L} ]{1,15}:\s*/u, "")
    // dopowiedzenie po myślniku: „…Cybisa 4 - garaż", „…12 – wejście od podwórza".
    // Krótkie i z małej litery, żeby nie uciąć nazwy w rodzaju „Poznań - Nowe Miasto".
    .replace(/\s+[-–—]\s+\p{Ll}[^-–—]{0,24}$/u, "")
    // ogon przyimkowy: „Park nad Wartą przy amfiteatrze" → „Park nad Wartą"
    .replace(/\s+(?:przy|koło|obok|naprzeciw(?:ko)?|nieopodal|pod)\s+\p{Ll}.*$/u, "");
}

/**
 * Zdejmuje prozę PRZED nazwą i sprowadza pierwszy wyraz do mianownika:
 * „przy fontannie na placu Wolności" → „plac Wolności".
 */
function trimLead(s: string): string {
  const words = s.split(" ");
  while (words.length > 1) {
    const w = words[0]!.toLowerCase();
    if (/^\p{Lu}/u.test(words[0]!) || STARTS.has(w) || STARTS.has(w.replace(/\./g, ""))) break;
    words.shift();
  }
  const head = words[0]?.toLowerCase();
  return head && head in CASES ? [CASES[head], ...words.slice(1)].join(" ") : words.join(" ");
}

/**
 * Jeden człon `venue` → zapytanie dla geokodera, albo null gdy pytać nie ma o co.
 *
 * Zdejmuje dokładnie te rzeczy, które sprawdzone trafiają w pustkę (patrz geoQueries).
 */
function toQuery(raw: string): string | null {
  let s = trimLead(trimProse(raw));
  // „ul."/„ulica" to JEDYNY prefiks, który psuje Nominatim — „al.", „os.", „pl." działają.
  // Kropka opcjonalna, bo źródła gminne piszą też „ul Gromadzka".
  s = s.replace(/^(?:ulica|ul)\.?\s+/i, "");
  // „Park Cytadela w Poznaniu" + doklejone „, Poznań" = miasto dwa razy, i już nie trafia.
  // Miejscowość i tak dokładamy osobno, więc jej wtręt w nazwie jest zbędny.
  s = s.replace(/\s+w\s+\p{Lu}\p{L}+$/u, "");
  s = s.replace(/^[\s.,;–-]+|[\s.,;–-]+$/g, "");
  if (s.length < 3) return null;
  const tokens = s.split(" ");
  // Generyk odrzucamy, gdy człon to TO SŁOWO — ewentualnie z przymiotnikiem, czyli
  // drugim wyrazem z małej litery. „Sala kolumnowa" leci, „Hala Arena" zostaje,
  // bo wielka litera w drugim wyrazie znaczy nazwę własną.
  if (GENERIC.has(norm(tokens[0]!))
    && (tokens.length === 1 || (tokens.length === 2 && !/^\p{Lu}/u.test(tokens[1]!)))) return null;
  return s;
}

/** Kandydat do odpytania. `town` nadpisuje miejscowość wydarzenia, gdy człon niesie własną. */
export interface GeoQuery { q: string; town?: string }

/** Końcówki polskich przymiotników odmiejscowych po zdjęciu diakrytyków: -ski, -cki, -dzki. */
const ADJ = /(?:sk|ck|dzk)(?:i|a|ie|iego|iej|iemu|im|ich|a)$/;

/** Długość wspólnego przedrostka — na tyle, żeby „poznanska" dopiąć do „poznan". */
function shared(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Czy wyraz to przymiotnik od TEJ miejscowości: „poznańska" przy „Poznań", „łódzki"
 * przy „Łódź". Porównujemy przedrostkiem, bo derywacja gubi końcówkę i miesza spółgłoski
 * (Warszawa → warszawski, Kórnik → kórnicki) — cztery wspólne znaki wystarczą, żeby
 * odsiać przymiotnik od czegokolwiek innego („żeglarski" przy „Poznań" ma trzy).
 */
function isTownAdj(word: string, town: string): boolean {
  const w = norm(word);
  return w.length > 4 && ADJ.test(w) && shared(w, norm(town)) >= 4;
}

/**
 * Człon bez przymiotnika odmiejscowego, albo null gdy go tam nie ma.
 *
 * „Cytadela poznańska" to sposób, w jaki o tym miejscu MÓWI się w Poznaniu, ale OSM zna
 * je jako „Park Cytadela" i człon z przymiotnikiem nie trafia w NIC (sprawdzone na żywym
 * geokoderze 2026-08-15). Warunek „przymiotnik od `town`" jest tu istotny: bez niego
 * ucierpiałby „Ostrów Tumski" i „Klub żeglarski", gdzie przymiotnik NIESIE nazwę.
 *
 * Gdy po obcięciu zostaje sama głowa nazwy („park", „rynek"), wynik leci — to już generyk,
 * a nie miejsce, i geokoder odpowiedziałby pierwszą lepszą ulicą o takiej nazwie.
 */
function dropTownAdj(q: string, town: string): string | null {
  if (!town) return null;
  const words = q.split(" ");
  if (words.length < 2) return null;
  // przymiotnik stoi z jednej albo z drugiej strony: „Cytadela poznańska", „Poznańska Cytadela"
  const at = isTownAdj(words[words.length - 1]!, town) ? words.length - 1
    : isTownAdj(words[0]!, town) ? 0 : -1;
  if (at < 0) return null;
  const rest = words.filter((_, i) => i !== at);
  const head = norm(rest[0]!);
  if (rest.length === 1 && (STARTS.has(head) || GENERIC.has(head))) return null;
  return rest.join(" ");
}

/**
 * Rzeczowniki, które w polszczyźnie OTWIERAJĄ nazwę instytucji. Stojąc w środku członu
 * z wielkiej litery, są szwem między dwiema sklejonymi nazwami — patrz splitNames().
 */
const HEADS = new Set([
  "muzeum", "akademia", "uniwersytet", "politechnika", "teatr", "kino", "opera",
  "filharmonia", "galeria", "biblioteka", "kosciol", "katedra", "bazylika", "klasztor",
  "palac", "zamek", "dwor", "dworek", "ratusz", "stadion", "hala", "basen", "hipodrom",
  "centrum", "klub", "dom", "szkola", "liceum", "przedszkole", "swietlica", "amfiteatr",
  "skansen", "ogrod", "fort", "cytadela", "osrodek", "arena", "planetarium",
]);

/**
 * Dwie nazwy sklejone BEZ przecinka → dwa człony, albo null gdy szwu nie widać.
 *
 * „Akademia Lubrańskiego Muzeum Archidiecezjalne" — źródło wymieniło budynek i instytucję
 * jednym ciągiem, a rozbijanie po interpunkcji tego nie łapie. Jako całość zapytanie nie
 * trafia w nic; każda połówka osobno trafia w ten sam obiekt (sprawdzone 2026-08-15).
 *
 * Obie strony muszą mieć po dwa PEŁNE wyrazy — to jedyne, co odróżnia szew od głowy nazwy
 * stojącej w środku („Wiejski Dom Kultury") albo na końcu („Centrum Kultury Zamek"). Tam
 * podział zostawiłby ogryzek w rodzaju „Wiejski", a geokoder na taki ogryzek ODPOWIADA —
 * pierwszą lepszą ulicą o podobnej nazwie, w dobrym mieście, więc `inTown()` tego nie wyłapie.
 * Myślnik nie liczy się jako wyraz, bo „AMAkids - Akademia…" ma szew dopiero przy „Centrum".
 */
function splitNames(q: string): [string, string] | null {
  const words = q.split(" ");
  const clean = (s: string): string => s.replace(/^[\s.,;–—-]+|[\s.,;–—-]+$/g, "");
  const full = (s: string): number => s.split(" ").filter((w) => /[\p{L}\d]/u.test(w)).length;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i]!;
    if (!HEADS.has(norm(w)) || !/^\p{Lu}/u.test(w)) continue;
    const left = clean(words.slice(0, i).join(" "));
    const right = clean(words.slice(i).join(" "));
    if (full(left) < 2 || full(right) < 2) continue;
    return [left, right];
  }
  return null;
}

/** Wygląda na nazwę miejscowości: jeden–dwa wyrazy z wielkiej litery. */
export const isLocality = (s: string): boolean =>
  /^\p{Lu}[\p{L}-]+(\s\p{Lu}[\p{L}-]+)?$/u.test(s.trim());

/**
 * Szersze sito dla pola `town` — używa go WYŁĄCZNIE pytanie „gdzie leży ta miejscowość"
 * (`probeWhere` w nominatim.ts), nie rozbieranie adresu.
 *
 * `isLocality` jest tam za ciasne, bo pilnuje czego innego: rozstrzyga, czy lewa strona
 * przed „ul." to miejscowość, i pomyłka kosztuje tam zły adres. Tutaj pomyłka kosztuje
 * jedno darmowe zapytanie, które i tak wróci z „nie wiem" — sprawdzone 2026-08-21:
 * „Sala Fitness OSiR", „Restauracja Panorama" i „Poznań-Grunwald" nie trafiają w żadną osadę
 * ani w Polsce, ani na świecie. Za ciasne sito kosztuje za to konkret: „St. Julian's" (Malta)
 * i „Lloret de Mar" (Hiszpania) nie były w ogóle PYTANE, więc dwie wycieczki biura podróży
 * przechodziły do publikacji — a przy okazji zerowały licznik jałowych przebiegów hosta.
 *
 * Cyfra dyskwalifikuje (to już adres), przecinek też (to lista), i najwyżej cztery wyrazy.
 */
export const looksLikeTown = (s: string): boolean => {
  const t = s.trim();
  if (t.length < 3 || t.length > 40 || /[\d,;/]/.test(t)) return false;
  if (!/^\p{Lu}/u.test(t)) return false;
  return /^[\p{L}\s.'’-]+$/u.test(t) && t.split(/\s+/).length <= 4;
};

/**
 * „Mosina ul. Jana Cybisa 4" → ulica osobno, miejscowość osobno.
 *
 * Źródła gminne piszą adres jednym ciągiem, bez przecinka. Doklejenie do tego `ev.town`
 * daje „Mosina ul. Jana Cybisa 4, Poznań" — dwie miejscowości w jednym zapytaniu i pewne
 * pudło. Gdy przed „ul." stoi coś, co NIE wygląda na nazwę miejscowości („wejście od
 * ul. Mostowej 7"), lewa strona po prostu leci — to proza, nie miejsce.
 */
function splitLocality(part: string): { text: string; town?: string } {
  const m = /^(.*?)\s+(?:ulica|ul)\.?\s+(.+)$/iu.exec(part.trim());
  if (!m) return { text: part };
  const [, left, street] = m as unknown as [string, string, string];
  return isLocality(left) ? { text: street, town: left.trim() } : { text: street };
}

/**
 * Warianty zapytania z jednego `venue`, w kolejności prób — pierwszy trafiony wygrywa.
 *
 * Sedno poprawki. `venue` to zlepek „nazwa miejsca, adres" (tak go składa venueOf()),
 * a czasem trzy miejsca naraz albo zdanie. Nominatim w trybie free-form oczekuje JEDNEJ
 * rzeczy plus hierarchii administracyjnej — na zlepku dwóch nazw nie trafia NIC.
 * Sprawdzone na żywym geokoderze (2026-08-14): dziewięć adresów z auditu, które
 * jako całość dawały zero trafień, po rozbiciu na człony trafia komplet.
 *
 * Nazwa miejsca idzie PRZED adresem, bo daje celniejszą pinezkę: „Hipodrom Wola" wskazuje
 * hipodrom, a „Lutycka 34" salon jeździecki pod tym numerem.
 *
 * `town` służy tylko do rozpoznania przymiotnika odmiejscowego w nazwie; miejscowość do
 * samego zapytania dokłada `ask()`.
 */
export function geoQueries(venue: string, town = ""): GeoQuery[] {
  const out: GeoQuery[] = [];
  const seen = new Set<string>();
  const add = (q: string, own?: string): void => {
    const dedupe = `${norm(q)}|${own ? norm(own) : ""}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push(own ? { q, town: own } : { q });
  };
  // nawiasy to zwykle dopowiedzenie („(Ostrów Tumski)") — jako osobny, dalszy człon
  const parts = venue.replace(/[()]/g, ",").split(/[,;]|\s\/\s/);
  for (const p of parts) {
    const { text, town: own } = splitLocality(p);
    const q = toQuery(text);
    if (!q) continue;
    add(q, own);
    // Warianty idą PO oryginale: gdyby pełny człon jednak był w OSM, to on jest celniejszy —
    // skrócenie i rozklejenie mają ratować dopiero jego pudło.
    const bare = dropTownAdj(q, own ?? town);
    if (bare) add(bare, own);
    for (const half of splitNames(q) ?? []) add(half, own);
  }
  return out;
}
