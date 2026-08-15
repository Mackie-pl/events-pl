/**
 * Prywatne archiwum treści — Supabase Storage.
 *
 * Do publicznego repo trafiają dane zredagowane (pii.ts) i metryki. Surowce, których
 * nie wolno publikować, a bez których nie da się debugować jakości ekstrakcji, lądują tutaj:
 *   raw/    — pobrany tekst strony/PDF-a (wejście modelu, 1:1)
 *   llm/    — prompt + odpowiedź modelu dla każdego wywołania
 *   blocks/ — rozliczenie podziału na bloki: co weszło, jak pocięte, co poszło do modelu
 *   events/ — wydarzenia PRZED redakcją PII
 *
 * Zasady:
 *   - best effort: błąd archiwum NIGDY nie wywraca pipeline'u (to observability, nie produkt),
 *   - opt-in: bez SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY moduł jest cichym no-opem,
 *     więc `npm run daily` działa lokalnie bez żadnej konfiguracji,
 *   - deduplikacja treścią: ścieżka zawiera sha256, więc niezmieniona strona nie zajmuje
 *     miejsca drugi raz (x-upsert nadpisuje ten sam obiekt).
 *
 * Klucz service_role omija RLS — TYLKO do backendu/Actions, nigdy do frontendu.
 * Bucket musi być PRYWATNY.
 */

import { P } from "../config/index.js";
import { fetchUrl } from "./http.js";
import { describeError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import type { LlmCallRecord } from "./openrouter.js";

const BUCKET = (): string => P.SUPABASE_BUCKET.get();
/** Retencja: pomocnicze, do cyklicznego czyszczenia (Supabase nie ma lifecycle rules). */
export const RETENTION_DAYS = (): number => P.ARCHIVE_RETENTION_DAYS.get();

export interface ArchiveStats {
  uploaded: number;
  failed: number;
  bytes: number;
  skipped: number;
}

const stats: ArchiveStats = { uploaded: 0, failed: 0, bytes: 0, skipped: 0 };
let runId = "";
let llmSeq = 0;
/** Numer podziału w przebiegu — jedno źródło tnie stronę i każdy jej followup osobno. */
let blockSeq = 0;
/** Kontekst bieżącego źródła — pozwala przypiąć obiekty archiwum do SourceRun w runs.json. */
let currentSourceId = "";
let currentPaths: string[] = [];
/** Klucz odrzucony — nie próbujemy dalej w tym przebiegu (patrz put()). */
let authBroken = false;

/**
 * Supabase przemianował klucze API: `service_role` → **Secret key** (`sb_secret_…`),
 * `anon` → Publishable key (`sb_publishable_…`). Stare klucze JWT działają do końca 2026,
 * więc przyjmujemy obie nazwy zmiennej — zależnie od tego, co pokazuje panel Supabase.
 *
 * Celowo `||`, nie `??`: GitHub Actions wstawia nieustawiony sekret jako PUSTY STRING,
 * a nie undefined — przy `??` pusty SUPABASE_SECRET_KEY zjadłby fallback i cicho
 * wyłączył archiwum mimo poprawnie ustawionego SUPABASE_SERVICE_ROLE_KEY.
 */
export const supabaseKey = (): string =>
  P.SUPABASE_SECRET_KEY.get() || P.SUPABASE_SERVICE_ROLE_KEY.get() || "";

/**
 * Wczesne ostrzeżenie przed najczęstszą pomyłką: klucz publiczny (publishable/anon)
 * nie odczyta prywatnego bucketa, a Supabase odpowie na to mało czytelnym błędem.
 */
/**
 * Nowe klucze (`sb_secret_…`) NIE są JWT — wysłane w `Authorization: Bearer` powodują
 * `403 Invalid Compact JWS`, bo gateway próbuje je sparsować jako token. Idą więc wyłącznie
 * w nagłówku `apikey`. Klucze legacy (JWT `eyJ…`) działają w obu nagłówkach naraz.
 */
export function authHeaders(key: string): Record<string, string> {
  return key.startsWith("sb_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

export function keyLooksPublic(key: string): boolean {
  if (key.startsWith("sb_publishable_")) return true;
  const payload = key.split(".")[1]; // legacy: JWT z rolą "anon"
  if (!payload) return false;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString()) as { role?: string }).role === "anon";
  } catch {
    return false;
  }
}

/**
 * Wyłącznik na czas sondy jednego źródła (pipeline/extract/probe-source.ts).
 *
 * Sonda odsyła prompt, odpowiedź modelu i pobraną treść wprost do panelu — wysyłanie tego
 * samego do bucketa dokłada tylko obiekty nie do odróżnienia od przebiegów crona, akurat
 * w archiwum, którego jedynym zadaniem jest tłumaczenie tych przebiegów.
 */
let suppressed = false;

export function suppressArchive(on: boolean): void {
  suppressed = on;
}

const cfg = (): { url: string; key: string } | null => {
  if (suppressed) return null;
  const url = P.SUPABASE_URL.get();
  const key = supabaseKey();
  return url && key ? { url: url.replace(/\/+$/, ""), key } : null;
};

export const archiveEnabled = (): boolean => cfg() !== null;

/** Grupuje obiekty jednego przebiegu; runId = startedAt (ISO). */
export function beginRun(startedAt: string): void {
  runId = startedAt.replace(/[:.]/g, "-");
  llmSeq = 0;
  blockSeq = 0;
  authBroken = false;
  stats.uploaded = stats.failed = stats.bytes = stats.skipped = 0;
  if (archiveEnabled() && keyLooksPublic(supabaseKey())) {
    console.warn(
      "archiwum: podany klucz wygląda na publiczny (publishable/anon) — prywatny bucket go odrzuci.\n" +
      "  Supabase → Settings → API Keys → skopiuj **Secret key** (sb_secret_…), nie Publishable.",
    );
  }
}

export const archiveStats = (): ArchiveStats => ({ ...stats });

/** Otwiera kontekst źródła: kolejne obiekty trafią pod jego prefiks i do sourcePaths(). */
export function beginSource(sourceId: string): void {
  currentSourceId = sourceId;
  currentPaths = [];
}

/** Ścieżki zarchiwizowane od ostatniego beginSource() — do zapisania w SourceRun. */
export const sourcePaths = (): string[] => [...currentPaths];


/**
 * Upload jednego obiektu. Zwraca false przy błędzie — nigdy nie rzuca.
 * Po odrzuceniu klucza przestajemy próbować do końca przebiegu: przy 46 źródłach
 * daje to ~60 skazanych żądań i tyle samo linii w logu, które zasłaniają prawdziwy błąd.
 */
export async function put(path: string, body: string, contentType = "application/json"): Promise<boolean> {
  const c = cfg();
  if (!c) { stats.skipped++; return false; }
  if (authBroken) { stats.skipped++; return false; }
  try {
    const res = await fetchUrl(
      `${c.url}/storage/v1/object/${BUCKET()}/${path}`,
      {
        method: "POST",
        headers: {
          ...authHeaders(c.key),
          "Content-Type": contentType,
          "x-upsert": "true", // ta sama treść = ta sama ścieżka, nadpisujemy zamiast duplikować
        },
        body,
      },
      30_000,
      `Supabase Storage ${BUCKET()}/${path}`, // label: URL nie zawiera klucza, ale trzymamy spójny opis
    );
    if (!res.ok) {
      stats.failed++;
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 401 || res.status === 403 || detail.includes("Invalid Compact JWS")) {
        authBroken = true;
        console.warn(
          `archiwum: klucz odrzucony przez Supabase (HTTP ${res.status}: ${detail}).\n` +
          "  Reszta przebiegu bez archiwizacji — pipeline leci dalej, dane publiczne bez zmian.\n" +
          "  \"Invalid Compact JWS\" = klucz nie jest JWT: to nowy format sb_secret_…, który idzie\n" +
          "  w nagłówku apikey, nie w Authorization. Sprawdź też, czy bucket istnieje i jest prywatny.",
        );
      } else {
        console.warn(`archiwum: ${path} → HTTP ${res.status} ${detail}`);
      }
      return false;
    }
    stats.uploaded++;
    stats.bytes += Buffer.byteLength(body);
    currentPaths.push(path);
    return true;
  } catch (e) {
    stats.failed++;
    console.warn(`archiwum: ${path} → ${describeError(e)}`);
    return false;
  }
}

/**
 * Odczyt archiwum — potrzebny pomiarom, nie potokowi.
 *
 * Potok pisze i nigdy nie czyta, więc do 2026-08 tego tu nie było. Pierwszym czytelnikiem
 * jest `npm run measure-reuse`: pyta archiwum „ile z dzisiejszej treści widzieliśmy wczoraj",
 * a odpowiedź leży wyłącznie w `raw/`, bo w repo trzymamy metryki, nie treść.
 *
 * Zwraca [] / null zamiast rzucać — dokładnie jak `put()`. Archiwum jest obserwowalnością,
 * a nie produktem: brak konfiguracji albo odrzucony klucz ma dawać pusty raport z komunikatem,
 * a nie stack trace.
 */

/** Jeden wpis listingu. `folder: true` = pseudokatalog (Supabase zwraca go z `id: null`). */
export interface ArchiveEntry {
  name: string;
  folder: boolean;
  bytes: number;
}

/**
 * Listing JEDNEGO poziomu pod prefiksem (`raw/`, `raw/2026-08-06/`, …).
 * Supabase tnie odpowiedź na 100 pozycji, więc stronicujemy do wyczerpania.
 */
export async function listArchive(prefix: string): Promise<ArchiveEntry[]> {
  const c = cfg();
  if (!c) return [];
  const out: ArchiveEntry[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    let page: { name: string; id: string | null; metadata: { size?: number } | null }[];
    try {
      const res = await fetchUrl(
        `${c.url}/storage/v1/object/list/${BUCKET()}`,
        {
          method: "POST",
          headers: { ...authHeaders(c.key), "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
        },
        30_000,
        `Supabase Storage list ${BUCKET()}/${prefix}`,
      );
      if (!res.ok) {
        console.warn(`archiwum: listing ${prefix} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return out;
      }
      page = (await res.json()) as typeof page;
    } catch (e) {
      console.warn(`archiwum: listing ${prefix} → ${describeError(e)}`);
      return out;
    }
    for (const it of page) out.push({ name: it.name, folder: it.id === null, bytes: it.metadata?.size ?? 0 });
    if (page.length < limit) return out;
  }
}

/** Treść jednego obiektu archiwum; null = brak, błąd albo wyłączone archiwum. */
export async function getArchive(path: string): Promise<string | null> {
  const c = cfg();
  if (!c) return null;
  try {
    const res = await fetchUrl(
      `${c.url}/storage/v1/object/${BUCKET()}/${path}`,
      { headers: authHeaders(c.key) },
      30_000,
      `Supabase Storage get ${BUCKET()}/${path}`,
    );
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.warn(`archiwum: pobranie ${path} → ${describeError(e)}`);
    return null;
  }
}

const day = (): string => new Date().toISOString().slice(0, 10);

/** Surowy tekst pobranej strony/PDF-a; ścieżka niesie hash, więc treść jest deduplikowana. */
export async function archiveRaw(sourceId: string, url: string, text: string, kind: string): Promise<string | null> {
  if (!archiveEnabled()) return null;
  const hash = sha256(text);
  const path = `raw/${day()}/${sourceId}/${hash}.json`;
  const body = {
    runId, sourceId, url, kind, fetchedAt: new Date().toISOString(), chars: text.length, text,
  };
  const ok = await put(path, JSON.stringify(body, null, 1));
  return ok ? path : null;
}

/**
 * Prompt + odpowiedź modelu. Obrazy (plakaty w base64) zastępujemy metadanymi —
 * archiwum ma służyć debugowaniu, a nie przechowywaniu megabajtów base64.
 *
 * Zwraca ścieżkę (jak `archiveRaw`), bo bez niej krok śladu wiedział tylko, ŻE model
 * był wołany — ścieżka wędruje przez `CallRecorder` do detali kroku i robi z niej link.
 */
export async function archiveLlmCall(rec: LlmCallRecord): Promise<string | null> {
  if (!archiveEnabled()) return null;
  const user = typeof rec.user === "string"
    ? rec.user
    : rec.user.map((p) =>
        p.type === "image_url"
          ? { type: "image_url", omitted: true, bytes: p.image_url.url.length }
          : p,
      );
  const seq = String(++llmSeq).padStart(4, "0");
  const path =
    `llm/${day()}/${runId}/${currentSourceId || "_"}/${seq}-${rec.model.replace(/\//g, "_")}.json`;
  const ok = await put(
    path,
    JSON.stringify({ ...rec, user, runId, sourceId: currentSourceId || null }, null, 1),
  );
  return ok ? path : null;
}

/**
 * Rozliczenie JEDNEGO podziału na bloki: co weszło, jak pocięte, co z tego poszło do modelu.
 *
 * Osobny obiekt od `raw/`, bo odpowiada na inne pytanie. `raw/` mówi, CO potok zobaczył;
 * to mówi, jak z tego zrobił bloki — czyli jedyną rzecz, której z rachunku nie widać:
 * strona bez zmian, która i tak kosztuje, ma tu wypisane, który blok się rozjechał i o ile.
 *
 * Zwraca ścieżkę jak `archiveLlmCall`, i z tego samego powodu: bez niej krok śladu wiedziałby
 * tylko, ILE bloków było.
 */
export async function archiveBlocks(url: string, payload: object): Promise<string | null> {
  if (!archiveEnabled()) return null;
  const seq = String(++blockSeq).padStart(4, "0");
  const path = `blocks/${day()}/${runId}/${currentSourceId || "_"}/${seq}.json`;
  const ok = await put(
    path,
    JSON.stringify({ runId, sourceId: currentSourceId || null, url, ...payload }, null, 1),
  );
  return ok ? path : null;
}

/** Wydarzenia PRZED redakcją PII — pełna wersja do digestu i debugowania. */
export async function archiveEventsFull(payload: unknown): Promise<void> {
  if (!archiveEnabled()) return;
  await put(`events/${day()}/${runId}.json`, JSON.stringify(payload, null, 1));
}
