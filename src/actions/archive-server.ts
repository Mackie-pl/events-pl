/**
 * Lokalny most do prywatnego archiwum (Supabase Storage) — wyłącznie na własnym PC.
 *
 * Panel jest statyczną stroną na GitHub Pages: wszystko, co potrafi przeczytać bez logowania,
 * przeczyta też każdy inny odwiedzający. Dlatego klucz sekretny NIGDY nie trafia do panelu —
 * zostaje tutaj, w procesie node'owym na localhoście, a panel pyta ten serwer.
 *
 * Wdrożony panel odpytuje 127.0.0.1, nie dostaje odpowiedzi i po prostu chowa sekcję archiwum.
 * Żeby zobaczyć treści: uzupełnij .env i uruchom `npm run archive-server` obok panelu.
 *
 * Nasłuch tylko na 127.0.0.1 (nie 0.0.0.0) — usługa nie wychodzi poza tę maszynę.
 */
import { createServer } from "node:http";

import { authHeaders, keyLooksPublic, supabaseKey } from "../adapters/supabase-archive.js";
import { fetchUrl } from "../adapters/http.js";
import { describeError } from "../shared/errors.js";

const PORT = Number(process.env["ARCHIVE_PORT"] ?? 8787);
const BUCKET = process.env["SUPABASE_BUCKET"] ?? "archive";
const SUPABASE_URL = (process.env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
const KEY = supabaseKey();

if (!SUPABASE_URL || !KEY) {
  console.error(
    "Brak SUPABASE_URL lub klucza (SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY).\n" +
    "Uzupełnij .env — klucz zostaje tylko tutaj, nigdy w panelu.",
  );
  process.exit(1);
}
if (keyLooksPublic(KEY)) {
  console.error(
    "To klucz publiczny (publishable/anon) — prywatnego bucketa nie odczyta.\n" +
    "Supabase → Settings → API Keys → **Secret key** (sb_secret_…).",
  );
  process.exit(1);
}

/** Panel bywa serwowany z kilku miejsc lokalnych — pozwalamy tylko na nie. */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const cors = (origin: string | undefined): Record<string, string> =>
  origin && ALLOWED_ORIGIN.test(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};

const json = (
  res: import("node:http").ServerResponse, code: number, body: unknown, extra: Record<string, string>,
): void => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  const headers = cors(origin);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "Access-Control-Allow-Headers": "content-type" });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, { ok: true, bucket: BUCKET }, headers);
    return;
  }

  if (url.pathname === "/object") {
    const path = url.searchParams.get("path") ?? "";
    // tylko ścieżki, które sami zapisujemy — bez wycieczek po całym buckecie
    if (!/^(raw|llm|events)\/[\w./:-]+$/.test(path) || path.includes("..")) {
      json(res, 400, { error: "niedozwolona ścieżka" }, headers);
      return;
    }
    void (async (): Promise<void> => {
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
    })();
    return;
  }

  json(res, 404, { error: "nieznana ścieżka" }, headers);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Archiwum: http://127.0.0.1:${PORT} → bucket "${BUCKET}" (tylko localhost)`);
  console.log("Panel wykryje serwer sam; zamknij go, gdy skończysz przeglądać.");
});
