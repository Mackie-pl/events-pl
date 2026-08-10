/**
 * Lokalny most panelu — wyłącznie na własnym PC. Robi trzy rzeczy, których statyczna
 * strona na GitHub Pages zrobić nie może:
 *
 *   GET  /file?name=runs.json        oddaje plik z DRZEWA ROBOCZEGO, nie z gałęzi main
 *   GET  /object?path=…              czyta obiekt z prywatnego archiwum (Supabase Storage):
 *                                    zrzuty `raw/`, wywołania `llm/` i przykłady `reuse/`
 *   POST /probe?source=<id>[&force=1] sprawdza JEDNO źródło tu i teraz, bez zapisu
 *
 * `/file` istnieje, bo panel domyślnie czyta raw.githubusercontent.com — czyli stan
 * OPUBLIKOWANY. Przebieg puszczony lokalnie zapisuje do drzewa roboczego i był niewidoczny
 * aż do commita i pusha (plus kilka minut cache CDN). Przy iteracji nad discovery to pętla
 * „zatwierdź, żeby zobaczyć, co zatwierdzasz" — dokładnie odwrotnie, niż powinna wyglądać.
 *
 * Wspólny powód, dla którego to musi być osobny proces: panel to publiczny statyczny bundle.
 * Wszystko, co potrafi przeczytać bez logowania, przeczyta też każdy odwiedzający — więc klucz
 * sekretny nigdy do niego nie trafia, a pobranie strony i wywołanie modelu (płatne!) nie może
 * być czymś, co odpala się z publicznego adresu. Jedno i drugie zostaje tutaj, na localhoście.
 *
 * Wdrożony panel odpytuje 127.0.0.1, nie dostaje odpowiedzi i po prostu chowa oba przyciski.
 * Żeby ich używać: `npm run panel-server` obok `npm start` w panelu.
 *
 * Nasłuch tylko na 127.0.0.1 (nie 0.0.0.0) — usługa nie wychodzi poza tę maszynę.
 *
 * Archiwum jest OPCJONALNE: bez SUPABASE_* most i tak wstaje, bo sonda niczego od Supabase
 * nie potrzebuje (prompt i odpowiedź modelu odsyła wprost do panelu). Wtedy /object zwraca 503,
 * a panel pokazuje samą listę ścieżek.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

import { authHeaders, keyLooksPublic, supabaseKey } from "../adapters/supabase-archive.js";
import { fetchUrl } from "../adapters/http.js";
import { ProbeError, probeSource } from "../pipeline/extract/probe-source.js";
import { describeError } from "../shared/errors.js";
import {
  AUDIT_PATH, COSTS_PATH, DISCOVER_RUNS_PATH, EVENTS_PATH, REUSE_PATH, RUNS_PATH, SOURCES_PATH,
  YIELD_PATH,
} from "../shared/paths.js";

const PORT = Number(process.env["ARCHIVE_PORT"] ?? 8787);
const BUCKET = process.env["SUPABASE_BUCKET"] ?? "archive";
const SUPABASE_URL = (process.env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
const KEY = supabaseKey();

/** Czy da się czytać archiwum. Brak konfiguracji nie jest błędem — wyłącza jedną z dwóch funkcji. */
const ARCHIVE = Boolean(SUPABASE_URL && KEY && !keyLooksPublic(KEY));

/** Panel bywa serwowany z kilku miejsc lokalnych — pozwalamy tylko na nie. */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Pliki danych oddawane pod `/file`. JAWNA MAPA nazwa → ścieżka, nie sklejanie katalogu
 * z parametrem: przy sklejaniu każdy `..` albo ścieżka bezwzględna to wyciek dowolnego pliku
 * z dysku do przeglądarki. Tu zbiór adresowalnych plików jest skończony i wypisany wprost,
 * więc nie ma czego walidować ani co przeoczyć.
 */
const LOCAL_FILES: Readonly<Record<string, string>> = {
  "sources.json": SOURCES_PATH,
  "events.json": EVENTS_PATH,
  "runs.json": RUNS_PATH,
  "audit.json": AUDIT_PATH,
  "discover-runs.json": DISCOVER_RUNS_PATH,
  "costs.json": COSTS_PATH,
  "reuse.json": REUSE_PATH,
  "yield.json": YIELD_PATH,
};

const cors = (origin: string | undefined): Record<string, string> =>
  origin && ALLOWED_ORIGIN.test(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};

const json = (
  res: ServerResponse, code: number, body: unknown, extra: Record<string, string>,
): void => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
};

async function handleObject(res: ServerResponse, path: string, headers: Record<string, string>): Promise<void> {
  try {
    const r = await fetchUrl(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
      { headers: authHeaders(KEY) },
      30_000,
      `Supabase ${BUCKET}/${path}`,
    );
    const body = await r.text();
    if (!r.ok) {
      json(res, r.status, { error: `Supabase HTTP ${r.status}`, detail: body.slice(0, 300) }, headers);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(body);
  } catch (e) {
    json(res, 502, { error: describeError(e) }, headers);
  }
}

/**
 * Jedna sonda naraz. Nie z ostrożności o wydajność: ślad decyzyjny, licznik tokenów i recorder
 * wywołań LLM to stan MODUŁOWY (tak jak w przebiegu crona, gdzie źródła i tak idą po kolei).
 * Dwie równoległe sondy pomieszałyby sobie kroki i koszty. Przy okazji sufit na wydatki:
 * przytrzymany przycisk nie zamieni się w dziesięć równoległych wywołań modelu.
 */
let inFlight: string | null = null;

async function handleProbe(
  res: ServerResponse, id: string, force: boolean, headers: Record<string, string>,
): Promise<void> {
  if (inFlight) {
    json(res, 409, { error: `Sonda źródła „${inFlight}" jeszcze trwa — poczekaj na wynik` }, headers);
    return;
  }
  inFlight = id;
  const t0 = Date.now();
  console.log(`sonda: ${id}${force ? " (force — pominięty cache, model będzie wołany)" : ""}`);
  try {
    const result = await probeSource(id, { force });
    console.log(
      `sonda: ${id} → ${result.run.status}, ${result.run.events} wydarzeń, ` +
      `$${result.run.llm.costUsd.toFixed(4)}, ${Date.now() - t0} ms`,
    );
    json(res, 200, result, headers);
  } catch (e) {
    if (e instanceof ProbeError) {
      json(res, e.status, { error: e.message }, headers);
      return;
    }
    // awaria sondy nie może ubić mostu — panel dostaje komunikat, serwer żyje dalej
    const err = describeError(e);
    console.warn(`sonda: ${id} → ${err}`);
    json(res, 500, { error: err }, headers);
  } finally {
    inFlight = null;
  }
}

function routeObject(url: URL, res: ServerResponse, headers: Record<string, string>): void {
  if (!ARCHIVE) {
    json(res, 503, { error: "archiwum nieskonfigurowane — uzupełnij SUPABASE_URL i klucz w .env" }, headers);
    return;
  }
  const path = url.searchParams.get("path") ?? "";
  // tylko ścieżki, które sami zapisujemy — bez wycieczek po całym buckecie
  if (!/^(raw|llm|events|reuse)\/[\w./:-]+$/.test(path) || path.includes("..")) {
    json(res, 400, { error: "niedozwolona ścieżka" }, headers);
    return;
  }
  void handleObject(res, path, headers);
}

/**
 * Plik danych z drzewa roboczego. Brak pliku to 404 z komunikatem, nie awaria mostu:
 * `audit.json` pojawia się dopiero po pierwszym przebiegu, a `costs.json` po pierwszym
 * z księgą kosztów — panel musi umieć pokazać resztę.
 */
async function handleFile(res: ServerResponse, name: string, headers: Record<string, string>): Promise<void> {
  const path = LOCAL_FILES[name];
  if (!path) {
    json(res, 400, { error: `nieznany plik „${name}"; dozwolone: ${Object.keys(LOCAL_FILES).join(", ")}` }, headers);
    return;
  }
  try {
    const body = await readFile(path, "utf8");
    // no-store: sens tego wejścia to ŚWIEŻY stan drzewa roboczego, a nie kopia sprzed przebiegu
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body);
  } catch (e) {
    const code = (e as { code?: string }).code === "ENOENT" ? 404 : 500;
    json(res, code, { error: describeError(e) }, headers);
  }
}

function routeProbe(
  req: IncomingMessage, url: URL, res: ServerResponse, headers: Record<string, string>,
): void {
  // POST, bo to wywołanie kosztuje pieniądze — GET-a przeglądarka potrafi wysłać sama
  // (prefetch, podgląd linku), a i historia z takim adresem to proszenie się o kłopoty.
  if (req.method !== "POST") {
    json(res, 405, { error: "sonda tylko przez POST" }, headers);
    return;
  }
  // CORS blokuje ODCZYT odpowiedzi, nie samo żądanie — bez tego dowolna otwarta strona
  // mogłaby po cichu odpalać płatne wywołania modelu na twoim localhoście. Brak nagłówka
  // Origin przepuszczamy (curl, CLI): przeglądarka wysyła go przy POST zawsze.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    json(res, 403, { error: "niedozwolone źródło żądania" }, {});
    return;
  }
  const id = url.searchParams.get("source") ?? "";
  if (!id) {
    json(res, 400, { error: "brak parametru ?source=<id>" }, headers);
    return;
  }
  void handleProbe(res, id, url.searchParams.get("force") === "1", headers);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const headers = cors(req.headers.origin);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "Access-Control-Allow-Headers": "content-type" });
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    // `files: true` przełącza panel na drzewo robocze — patrz data.ts w panelu
    json(res, 200, { ok: true, archive: ARCHIVE, bucket: BUCKET, files: true }, headers);
    return;
  }
  if (url.pathname === "/file") {
    void handleFile(res, url.searchParams.get("name") ?? "", headers);
    return;
  }
  if (url.pathname === "/object") return routeObject(url, res, headers);
  if (url.pathname === "/probe") return routeProbe(req, url, res, headers);

  json(res, 404, { error: "nieznana ścieżka" }, headers);
}

createServer(route).listen(PORT, "127.0.0.1", () => {
  console.log(`Most panelu: http://127.0.0.1:${PORT} (tylko localhost)`);
  console.log(`  dane: panel czyta pliki z DRZEWA ROBOCZEGO, nie z gałęzi main na GitHubie`);
  console.log(`  sonda źródeł: POST /probe?source=<id>[&force=1] — nic nie zapisuje`);
  console.log(ARCHIVE
    ? `  archiwum: bucket "${BUCKET}"`
    : "  archiwum: wyłączone (brak SUPABASE_URL / klucza w .env) — sonda działa mimo to");
  if (KEY && keyLooksPublic(KEY)) {
    console.warn(
      "  uwaga: podany klucz jest publiczny (publishable/anon) — prywatnego bucketa nie odczyta.\n" +
      "  Supabase → Settings → API Keys → **Secret key** (sb_secret_…).",
    );
  }
  console.log("Panel wykryje most sam; zamknij go, gdy skończysz.");
});
