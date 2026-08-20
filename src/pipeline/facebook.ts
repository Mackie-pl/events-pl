/**
 * Warstwa FB — czysta transformacja (bez sieci):
 *   - wyłuskiwanie i normalizacja linków do wydarzeń FB z dowolnego tekstu,
 *   - mapowanie rekordu Bright Data (Facebook Events) → EventItem,
 *   - spłaszczanie postów z grupy FB do tekstu dla ekstraktora LLM.
 *
 * Nazwy pól Bright Data bywają różne między wersjami scrapera — sięgamy defensywnie
 * po kilka wariantów każdego pola.
 */
import type { BdRecord } from "../adapters/brightdata.js";
import { parseInstant, splitDateTime } from "../shared/dates.js";
import { normalizeFbCdnUrl, urlKey } from "../shared/url.js";
import type { AgeRange, EventItem, EventOrigin, FbGroupStats, Price } from "../types/index.js";

const EVENT_URL_RE = /(?:https?:\/\/)?(?:[\w-]+\.)?facebook\.com\/events\/(\d+)/gi;

/** Wyłuskaj i znormalizuj linki do wydarzeń FB z tekstu strony/postu. */
export function harvestEventUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EVENT_URL_RE)) {
    const id = m[1];
    if (id) out.add(`https://www.facebook.com/events/${id}`);
  }
  return [...out];
}

export function isEventUrl(url: string): boolean {
  return /facebook\.com\/events\/\d+/i.test(url);
}

/** Pierwsza niepusta wartość spośród kluczy (string lub number). */
function pick(rec: BdRecord, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Wyłuskaj miasto z polskiego adresu ("ul. X 1, 61-000 Poznań" → "Poznań"). */
function townFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  const cleaned = last.replace(/\d{2}-\d{3}/, "").trim();
  return cleaned || null;
}

/**
 * Rekord Bright Data (Facebook Events) → EventItem. Zwraca null gdy brak tytułu/daty
 * albo wydarzenie już się zakończyło (< today). Mapowanie strukturalne — bez LLM (zero dodatkowego kosztu).
 * Klasyfikacja wieku/rodzinności zostaje "otwarta" (age=null, family_friendly="maybe").
 */
/**
 * Miejsce: nazwa + adres, ale bez powielania — scraper często wkleja pełny adres
 * już w nazwę lokalu, a „Dom Kultury, ul. Główna 1, ul. Główna 1" wygląda na błąd danych.
 */
function venueOf(rec: BdRecord): { venue: string | null; town: string | null } {
  const venueName = pick(rec, "location", "venue", "place", "place_name", "location_name");
  const address = pick(rec, "address", "full_address", "location_address");
  const venue = venueName && address && !venueName.includes(address)
    ? `${venueName}, ${address}`
    : venueName ?? address;
  return { venue, town: pick(rec, "city") ?? townFromAddress(address) };
}

export function fbEventToItem(rec: BdRecord, today: string): EventItem | null {
  const title = pick(rec, "name", "title", "event_name");
  const start = splitDateTime(pick(rec, "start_date", "startDate", "date_start", "start_time", "start"));
  if (!title || !start.date) return null;

  const end = splitDateTime(pick(rec, "end_date", "endDate", "date_end", "end_time", "end"));
  const lastDay = end.date ?? start.date;
  if (lastDay < today) return null; // zakończone pomijamy

  const { venue, town } = venueOf(rec);
  const category = pick(rec, "category", "event_type");
  const price: Price = { free: null, amount_pln: null, note: null };
  const age: AgeRange = { min: null, max: null, label: null };

  return {
    title,
    date_start: start.date,
    date_end: end.date && end.date !== start.date ? end.date : null,
    repeat: "", // rekord FB opisuje jeden termin; serie zwija foldSeries()
    time_start: start.time,
    time_end: end.time,
    // "" zamiast null w polach czysto tekstowych — kontrakt schematu, patrz orEmpty()
    // w types/event-schema.ts (budżet 16 pól unijnych u dostawcy)
    venue: venue ?? "",
    town: town ?? "",
    price,
    age,
    family_friendly: "maybe",
    tags: [category ? `fb:${category.toLowerCase()}` : "fb:wydarzenie"],
    registration: pick(rec, "ticket_url", "tickets_url", "external_url", "registration_url") ?? "",
    sub_slots: null,
    conditional: "",
    container: "", // wydarzenie FB jest zawsze samodzielne — nie ma programu do rozbicia
    source_url: pick(rec, "url", "event_url", "input_url", "link") ?? "",
    is_noise: false,
    geo: null,
  };
}

/** Treść postu — ten sam zestaw wariantów, którego używa spłaszczanie do tekstu. */
const postContent = (r: BdRecord): string | null =>
  pick(r, "content", "text", "post_text", "message", "description", "post_content");

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Rytm publikacji grupy, zmierzony na rekordach, za które właśnie zapłaciliśmy.
 *
 * Rozliczenie Bright Data jest per-rekord, a limit na grupę jest dziś jedną stałą wziętą
 * z sufitu — więc wioskowa grupa z jednym postem na tydzień kosztuje tyle samo, co poznańska
 * z dwustoma dziennie, i obie oddają równo `limit` rekordów. Ten pomiar rozróżnia te dwa
 * przypadki i jest wejściem do limitu liczonego osobno dla każdej grupy. Sam limitu NIE
 * rusza — najpierw kilka dni pomiaru, potem decyzja.
 *
 * Rekord bez treści to przy `include_errors=true` raport błędu scrapera (grupa prywatna,
 * usunięta, zmieniony adres), a nie post — płatny tak samo, wart zera. Rozdzielenie
 * `records` od `posts` jest jedynym miejscem, w którym ta różnica w ogóle widać.
 */
export function fbGroupStats(records: BdRecord[], limit: number): FbGroupStats {
  const times: number[] = [];
  let posts = 0;
  let errorRows = 0;
  let blockedWhy: string | null = null;

  for (const r of records) {
    if (postContent(r)) {
      posts += 1;
      const t = parseInstant(pick(r, "date_posted", "date", "timestamp", "created_time", "post_date"));
      if (t !== null) times.push(t);
    } else {
      errorRows += 1;
      blockedWhy ??= pick(r, "error", "warning", "error_code", "warning_code", "message");
    }
  }

  const stats: FbGroupStats = {
    records: records.length,
    posts,
    errorRows,
    limit,
    atLimit: records.length >= limit,
    ...(blockedWhy ? { blockedWhy } : {}),
  };
  if (!times.length) return stats;

  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  stats.newest = isoDay(newest);
  stats.oldest = isoDay(oldest);
  const spanDays = (newest - oldest) / 86_400_000;
  stats.spanDays = Number(spanDays.toFixed(2));
  // okno zerowe (wszystko z jednej chwili) nie daje się podzielić: wiadomo tylko tyle,
  // że tempo jest NIE MNIEJSZE niż `posts` na dobę — a to nie jest pomiar tempa
  if (spanDays > 0) stats.postsPerDay = Number((posts / spanDays).toFixed(1));
  return stats;
}

/**
 * Posty z grupy FB (rekordy Bright Data) → jeden blok tekstu dla ekstraktora LLM.
 * Zachowujemy datę i link postu, żeby model mógł wywnioskować rok i osadzić source_url.
 */
/**
 * Co jeszcze siedzi w opłaconym rekordzie, a czego NIE dostaje model.
 *
 * Spłaszczanie do tekstu bierze wyłącznie treść postu, więc plakat — na którym u wielu
 * ogłoszeń stoi całe „gdzie" — nie istnieje dla potoku. Zmierzone na „W podwodnym świecie"
 * (fb-group-wydarzenia-w-poznaniu-1, 2026-08-12): wydarzenie weszło do digestu z `venue: ""`,
 * bo lokalizacja była tylko na obrazku.
 *
 * To POMIAR, nie naprawa: nazwy pól datasetu Bright Data nie znamy (BdRecord to
 * `Record<string, unknown>`, a archiwum trzyma tekst już po spłaszczeniu), a wstawienie pola
 * o nieznanym znaczeniu do promptu groziłoby wymyślonym miejscem. Najpierw ślad mówi, KTÓRE
 * pole niesie obraz i w ilu postach — dopiero to jest wejściem do decyzji o czytaniu plakatów.
 */
export interface FbPostExtras {
  /** pole z obrazem, pierwsze rozpoznane; null = w żadnym poście nic nie znaleziono */
  imageField: string | null;
  /** ile POSTÓW (nie rekordów) ma choć jeden obraz */
  withImage: number;
  /** pole z miejscem/adresem postu, jeśli scraper takie oddaje */
  placeField: string | null;
  withPlace: number;
  /** jeden URL do obejrzenia w śladzie — czy w ogóle da się go pobrać bez ciasteczek FB */
  sampleImage: string | null;
  /** pole z autorem postu, jeśli scraper takie oddaje; null = dataset go nie zwraca */
  authorField: string | null;
  /** ilu RÓŻNYCH autorów napisało te posty */
  authors: number;
  /** ile postów ma najaktywniejszy autor — to jest liczba rozstrzygająca o „tym samym gościu" */
  maxPostsByAuthor: number;
  /** ilu autorów napisało więcej niż jeden post w tym oknie */
  repeatAuthors: number;
}

/** Kolejność od najbardziej konkretnego: pierwsze pole z URL-em wygrywa i trafia do śladu. */
const IMAGE_KEYS = [
  "attachments", "photos", "images", "post_image", "post_images",
  "image", "photo", "media", "attachment", "thumbnail",
];

const PLACE_KEYS = ["location", "place", "place_name", "venue", "location_name", "address"];

/**
 * URL-e ukryte w wartości pola. Scrapery oddają obrazy raz jako string, raz jako listę
 * stringów, raz jako listę obiektów `{url}` — a nazwy pól bywają różne między wersjami,
 * więc zgadujemy kształt, nie polegamy na jednym.
 *
 * Adres wychodzi stąd już z generycznym edge'em CDN-u (`normalizeFbCdnUrl`), bo to jedyne
 * miejsce, przez które obraz z rekordu wchodzi do potoku — normalizacja postawiona dalej
 * musiałaby być pamiętana w każdym następnym odbiorcy.
 */
function urlsIn(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    const s = value.trim();
    return /^https?:\/\//i.test(s) ? [normalizeFbCdnUrl(s)] : [];
  }
  if (depth >= 2) return []; // dalej niż listę obiektów nie schodzimy — to już nie jest pole z URL-em
  if (Array.isArray(value)) return value.flatMap((v) => urlsIn(v, depth + 1));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return ["url", "src", "uri", "link", "image", "photo"].flatMap((k) => urlsIn(rec[k], depth + 1));
  }
  return [];
}

/**
 * Pola, w których scrapery FB trzymają autora postu. Jak przy obrazach: nazwy różnią się
 * między wersjami datasetu, więc próbujemy kilku zamiast zakładać jedną.
 */
const AUTHOR_KEYS = [
  "user_url", "profile_url", "user_id", "profile_id", "author", "user",
  "post_owner", "owner", "user_username_raw", "username",
] as const;

/**
 * Tożsamość autora WYŁĄCZNIE do policzenia — wartość nigdy nie opuszcza tej funkcji.
 *
 * To nie jest ostrożność na wyrost: repo jest publiczne, `audit.json` jest commitowany,
 * a autor posta w wiejskiej grupie to osoba prywatna, nie instytucja. Do pytania „czy ten
 * sam ktoś wrzuca dziesięć ogłoszeń miesięcznie" wystarczą LICZNIKI — kto to jest, nie jest
 * nam do niczego potrzebne, więc tego nie zapisujemy (patrz pipeline/pii.ts).
 */
function authorIdentity(rec: BdRecord): { key: string; field: string } | null {
  for (const field of AUTHOR_KEYS) {
    const v = rec[field];
    if (typeof v === "string" && v.trim()) return { key: v.trim(), field };
    if (typeof v === "number" && Number.isFinite(v)) return { key: String(v), field };
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const inner of ["id", "user_id", "profile_id", "url", "link", "name", "username"]) {
        const iv = o[inner];
        if (typeof iv === "string" && iv.trim()) return { key: iv.trim(), field };
        if (typeof iv === "number" && Number.isFinite(iv)) return { key: String(iv), field };
      }
    }
  }
  return null;
}

export function fbPostExtras(records: BdRecord[]): FbPostExtras {
  const out: FbPostExtras = {
    imageField: null, withImage: 0, placeField: null, withPlace: 0, sampleImage: null,
    authorField: null, authors: 0, maxPostsByAuthor: 0, repeatAuthors: 0,
  };
  // mapa żyje tylko w tej funkcji i ginie z nią — na zewnątrz idą same liczby
  const byAuthor = new Map<string, number>();
  for (const r of records) {
    // rekord bez treści to wiersz błędu scrapera, nie post — patrz fbGroupStats
    if (!postContent(r)) continue;
    for (const key of IMAGE_KEYS) {
      const urls = urlsIn(r[key]);
      if (!urls.length) continue;
      out.withImage += 1;
      out.imageField ??= key;
      out.sampleImage ??= urls[0] ?? null;
      break;
    }
    for (const key of PLACE_KEYS) {
      if (!pick(r, key)) continue;
      out.withPlace += 1;
      out.placeField ??= key;
      break;
    }
    const who = authorIdentity(r);
    if (who) {
      out.authorField ??= who.field;
      byAuthor.set(who.key, (byAuthor.get(who.key) ?? 0) + 1);
    }
  }
  out.authors = byAuthor.size;
  for (const n of byAuthor.values()) {
    if (n > out.maxPostsByAuthor) out.maxPostsByAuthor = n;
    if (n > 1) out.repeatAuthors += 1;
  }
  return out;
}

/**
 * Post → ile obrazów niesie, kluczowane tak samo jak `fbOriginsByPost` (`urlKey` adresu postu).
 *
 * Osobno od `fbPostExtras`, bo tamto liczy SUMY dla grupy, a tu potrzebna jest przynależność
 * pojedynczego postu: dopiero ona pozwala zestawić post z wydarzeniami, które z niego wyszły.
 * Post bez adresu wypada — nie ma czym go związać z `source_url`, a zgadywanie po treści
 * dałoby wiązanie, które myli się cicho.
 */
export function fbImagePosts(records: BdRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (!postContent(r)) continue;
    const link = pick(r, "url", "post_url", "link", "post_link");
    if (!link) continue;
    let images = 0;
    for (const key of IMAGE_KEYS) {
      images = urlsIn(r[key]).length;
      if (images) break;
    }
    out.set(urlKey(link), images);
  }
  return out;
}

/** Plakat do przeczytania: obraz + post, przy którym stał. */
export interface FbPosterJob {
  imageUrl: string;
  postUrl: string;
  /** treść postu — jedzie do modelu jako KONTEKST, bo plakat rzadko niesie rok i adres */
  context: string;
  /**
   * Id autora prosto z rekordu — WYŁĄCZNIE do zahaszowania w `fb-author-mute.ts`.
   * Nie wolno tego zapisać ani wpisać do śladu: repo jest publiczne (patrz pipeline/pii.ts).
   */
  author: string | null;
}

/**
 * Posty, których załącznika warto spróbować przeczytać. BEZ filtra po metadanych i to jest
 * decyzja, nie niedopatrzenie.
 *
 * Sprawdzone 2026-08-19 na 11 obejrzanych obrazkach: proporcje nie oddzielają plakatu od
 * ogłoszenia (dwa prawdziwe plakaty stały na 0.66 i 1.92, czyli po obu skrajach, a śmieci
 * zajmowały wszystkie przedziały), a bajty/piksel jeszcze gorzej — plakat szkoleń dla
 * seniorów (0.097) kompresuje się LŻEJ niż zdjęcie borówek (0.101). Każdy próg po tych
 * liczbach kasuje prawdziwe wydarzenie.
 *
 * Asymetria mówi resztę: fałszywe „to nie plakat" znaczy, że wydarzenie nie powstanie
 * i nikt się o tym nie dowie, a fałszywe „plakat" kosztuje ~$0.001 (zmierzone) i widać je
 * w tabeli — model sam oddaje pustą listę dla zdjęcia borówek i dla ogłoszenia o hali.
 * Sitem jest więc SUFIT liczby odczytów (FB_POSTER_MAX_PER_RUN), nie zgadywanie z pikseli.
 */
export function fbPosterJobs(records: BdRecord[]): FbPosterJob[] {
  const out: FbPosterJob[] = [];
  for (const r of records) {
    const content = postContent(r);
    if (!content) continue; // wiersz błędu scrapera, nie post
    const postUrl = pick(r, "url", "post_url", "link", "post_link");
    if (!postUrl) continue; // bez adresu nie ma czym związać wydarzenia ze źródłem
    for (const key of IMAGE_KEYS) {
      const urls = urlsIn(r[key]);
      const first = urls[0];
      if (!first) continue;
      out.push({
        imageUrl: first, postUrl, context: content,
        author: authorIdentity(r)?.key ?? null,
      });
      break;
    }
  }
  return out;
}

/**
 * Nagłówek treści udostępnionego postu.
 *
 * Stała, bo ta sama etykieta jest czytana w DWÓCH miejscach: tutaj powstaje, a
 * `extract/date-hint.ts` wycina ją z dowodu — nagłówek niesie datę PUBLIKACJI oryginału,
 * i uznanie jej za termin wydarzenia to dokładnie ten błąd, przed którym stoi bezpiecznik.
 * Rozjazd tych dwóch miejsc byłby niewidoczny: potok dalej działa, tylko przepuszcza wymysły.
 */
export const SHARED_LABEL = "UDOSTĘPNIONE OGŁOSZENIE";

export interface FbOriginal extends EventOrigin {
  author: string | null;
  date: string | null;
  content: string;
}

/**
 * Oryginał spod udostępnienia. `post_id` jest kluczem pierwszego wyboru, bo przeżywa
 * zmianę adresu (rozkodowuje się do „S:_I<profil>:<story>:<story>"); adres jest zapasem.
 */
export function fbOriginal(rec: BdRecord): FbOriginal | null {
  const raw = rec["original_post"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const op = raw as BdRecord;
  const key = pick(op, "post_id", "post_url", "url");
  if (!key) return null;
  return {
    key,
    url: pick(op, "post_url", "url", "link") ?? "",
    author: pick(op, "user_name", "user_username_raw", "user_url"),
    date: pick(op, "date", "date_posted", "timestamp"),
    content: postContent(op) ?? "",
  };
}

/**
 * Post w grupie → jego oryginał. Mapa powstaje przy spłaszczaniu (jedyny moment, w którym
 * mamy rekordy), a używa jej process-source.ts do dopisania `origin` gotowym wydarzeniom.
 *
 * Klucz to `urlKey`, nie sam adres. Po drugiej stronie stoi `source_url` PRZEPISANY przez
 * model z wiersza „LINK:", a przepisując, potrafi zgubić `www.` albo schemat — i wtedy
 * dopasowanie nie zachodzi. Cicho: `origin` po prostu się nie dopisuje, nic nie krzyczy.
 * Ta sama normalizacja co w rejestrze źródeł, żeby były na to jedne reguły, nie trzy kopie.
 */
export function fbOriginsByPost(records: BdRecord[]): Map<string, EventOrigin> {
  const out = new Map<string, EventOrigin>();
  for (const r of records) {
    if (!postContent(r)) continue;
    const link = pick(r, "url", "post_url", "link", "post_link");
    const orig = fbOriginal(r);
    if (link && orig) out.set(urlKey(link), { key: orig.key, url: orig.url });
  }
  return out;
}

/**
 * Ten sam tekst „po literach": NFKC, małe litery, bez niczego poza literami i cyframi.
 *
 * Do PORÓWNANIA dwóch treści, nie do wysyłki — model dostaje oryginalny zapis. Odsiew
 * ozdobników jest tu warunkiem działania, bo udostępniający wkleja ogłoszenie z własnym
 * zdobieniem: „🕙Galeria czynna" wobec „Galeria czynna" to dla `===` dwa różne teksty,
 * a dla czytelnika jeden. Emoji, wcięcia i śródtytuł to typowa różnica między podpisem
 * a oryginałem — po ich odsianiu zostaje pytanie, o które chodzi: czy padło to samo zdanie.
 */
const canonical = (s: string): string =>
  s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Który z dwóch tekstów udostępnienia niesie coś, czego nie ma w drugim. */
export type FbShareShape = "podpis+oryginał" | "sam oryginał" | "sam podpis";

/**
 * Udostępniając, ludzie najczęściej WKLEJAJĄ ogłoszenie, zamiast je komentować — i wtedy
 * podpis jest kawałkiem oryginału, a blok mówi wszystko dwa razy.
 *
 * Zmierzone na żywym archiwum (2026-08-15, 198 postów z 15 grup, 75 udostępnień z treścią
 * oryginału): 14 podpisów co do znaku równych oryginałowi, 26 zawartych w nim, 2 zawierające
 * go w sobie — razem 42 z 75 (56%) i 12 959 z 18 777 znaków podpisów, które nie wnoszą nic.
 * Pozostałe 33 to podpisy naprawdę własne (0 wspólnych linii z oryginałem u 31 z nich), więc
 * odsiew idzie po ZAWIERANIU, a nie po „jest udostępnieniem".
 *
 * Zostaje ta strona, która jest nadzbiorem; przy równości — oryginał, bo nagłówek nad nim
 * niesie autora i datę PUBLIKACJI, a to od niej zależy, co znaczyło „dziś" w tekście.
 */
export function fbShareShape(caption: string, original: string): FbShareShape {
  const c = canonical(caption), o = canonical(original);
  if (o.includes(c)) return "sam oryginał"; // identyczne też tędy — nadzbiorem jest oryginał
  if (c.includes(o)) return "sam podpis";
  return "podpis+oryginał";
}

/**
 * Treść postu i treść oryginału — każda RAZ.
 *
 * Oryginał jest dokładany, nie podstawiany: ogłoszenie siedzi w nim (31.6% udostępnień ma
 * termin wyłącznie tam), ale wśród 95 udostępnień trafił się oryginał BEZ tekstu i wtedy
 * jedyną treścią jest podpis. Doklejenie kosztuje tokeny (+89% znaków, ok. $0.02 dziennie
 * przy rachunku $1.51 za samo FB) — więc kopia tego samego zdania kosztuje je bez powodu.
 *
 * Nagłówek niesie autora i datę oryginału, żeby model wiedział, czyja to treść — a „dziś"
 * w udostępnionym ogłoszeniu znaczyło dzień JEGO publikacji, nie dzień udostępnienia.
 * Znika razem z treścią, którą zapowiada: nagłówek nad niczym byłby gorszy niż jego brak.
 */
function postLines(rec: BdRecord, content: string): string[] {
  const orig = fbOriginal(rec);
  if (!orig?.content) return [content];
  const header = `${SHARED_LABEL} (${orig.author ?? "?"}, ${orig.date ?? "?"}) — to jest właściwe ogłoszenie:`;
  switch (fbShareShape(content, orig.content)) {
    case "sam oryginał": return [header, orig.content];
    case "sam podpis": return [content];
    default: return [content, header, orig.content];
  }
}

/** Ile z opłaconej treści udostępnień to kopia drugiej połowy postu — wejście do śladu. */
export interface FbShareStats {
  /** posty z oryginałem NIOSĄCYM treść (tylko takie da się porównać) */
  shares: number;
  onlyOriginal: number;
  onlyCaption: number;
  both: number;
  /** znaki, które przez odsiew nie pojechały do modelu */
  charsSaved: number;
}

export function fbShareStats(records: BdRecord[]): FbShareStats {
  const out: FbShareStats = { shares: 0, onlyOriginal: 0, onlyCaption: 0, both: 0, charsSaved: 0 };
  for (const r of records) {
    const content = postContent(r);
    const orig = fbOriginal(r);
    if (!content || !orig?.content) continue;
    out.shares += 1;
    switch (fbShareShape(content, orig.content)) {
      case "sam oryginał": out.onlyOriginal += 1; out.charsSaved += content.length; break;
      case "sam podpis": out.onlyCaption += 1; out.charsSaved += orig.content.length; break;
      default: out.both += 1;
    }
  }
  return out;
}

/** Separator postów w spłaszczonym tekście — i zarazem szew, wzdłuż którego idą bloki. */
const POST_SEPARATOR = "\n\n---\n\n";

/**
 * Posty jako OSOBNE bloki — po jednym na post.
 *
 * Podział na bloki (extract/blocks.ts) powstał dla stron skrobanych, gdzie granicę karty
 * trzeba zgadywać, bo `html-to-text` zdążył ją zniszczyć. Grupa FB jest jedynym wejściem,
 * które przychodzi JUŻ podzielone: Bright Data oddaje tablicę postów. Sklejanie jej w napis
 * i odtwarzanie granic hashem akapitu było więc zgadywaniem odpowiedzi, którą mamy —
 * i mylącym się dla 125 z 310 postów (2026-08-14), czyli tnącym post między tytuł a datę.
 *
 * Post jest przy okazji właściwą jednostką cache'a: jego treść się nie zmienia, więc hash
 * bloku jest stabilny na zawsze. Zysk widać tam, gdzie okno pobrania w ogóle się pokrywa —
 * na `fb-group-kultura-komorniki` (6 postów w oknie) 83% wobec 44% przy blokach z akapitów.
 * Na grupach, które wyczerpują limit w jedną dobę, nie pokrywa się nic i nie pomoże nic.
 */
export function fbGroupPostsToBlocks(records: BdRecord[]): string[] {
  const blocks: string[] = [];
  for (const r of records) {
    const content = postContent(r);
    if (!content) continue;
    const date = pick(r, "date_posted", "date", "timestamp", "created_time", "post_date");
    const link = pick(r, "url", "post_url", "link", "post_link");
    blocks.push(
      [
        date ? `DATA POSTU: ${date}` : null,
        link ? `LINK: ${link}` : null,
        ...postLines(r, content),
      ].filter(Boolean).join("\n"),
    );
  }
  return blocks;
}

/**
 * Ten sam materiał jako jeden napis. Zostaje, bo liczy się z niego hash treści źródła,
 * kopia w archiwum i dowód bezpiecznika (`postsByLink`) — trzy rzeczy, które muszą widzieć
 * DOKŁADNIE to, co widział model. Bloki są sklejeniem tego napisu, nie odwrotnie.
 */
export const fbGroupPostsToText = (records: BdRecord[]): string =>
  fbGroupPostsToBlocks(records).join(POST_SEPARATOR);
