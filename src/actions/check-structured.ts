/**
 * Sonda structured outputs: kilka tanich wywołań, żeby odpowiedzieć na pytanie, którego
 * nie da się rozstrzygnąć z dokumentacji — czy MODEL_EXTRACT przez OpenRoutera przyjmuje
 * `response_format: json_schema`, a jeśli nie, to CZY W OGÓLE NIE, czy tylko nie NASZ schemat.
 *
 * To rozróżnienie jest całym sensem tego pliku. „Odrzucony" bez niego prowadzi do złego
 * wniosku („model nie umie"), podczas gdy realnym powodem bywa jedno słowo kluczowe:
 * dialekt `json_schema` u OpenRoutera wzoruje się na strict mode OpenAI, a ten nie przyjmuje
 * m.in. `format`. Dlatego sonda schodzi po schodkach: pełny schemat → schemat minimalny
 * → pełny bez `format`. Odrzucone wywołania nie kosztują (400 nie zużywa tokenów).
 *
 *   npm run check:structured
 *
 * Sonda NIE zmienia konfiguracji. Włączenie to świadome STRUCTURED_OUTPUTS=1 w .env.
 */
import { Value } from "@sinclair/typebox/value";

import { toWireSchema } from "../shared/json-schema.js";
import { ExtractionSchema } from "../types/event-schema.js";

const SAMPLE = `KONCERT LETNI W PARKU
15 sierpnia 2026, godz. 18:00, Park Miejski w Luboniu, wstęp wolny.
Dla całych rodzin, dzieci od 4 lat. Przy deszczu przeniesione do sali GOK.`;

/** Najprostszy możliwy schemat — sprawdza samą obsługę response_format, nie nasz kształt. */
const MINIMAL = {
  type: "object",
  properties: { odpowiedz: { type: "string" } },
  required: ["odpowiedz"],
  additionalProperties: false,
};

/** Nasz schemat bez `format` — pierwszy podejrzany, gdy minimalny przechodzi, a pełny nie. */
function withoutFormat(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema, (key, value: unknown) =>
    key === "format" ? undefined : value)) as unknown;
}

type Api = typeof import("../adapters/openrouter.js");

interface Attempt { out: string | null; provider: string }

/** Dostawca z komunikatu błędu — errorText() wstawia go w nawiasie kwadratowym. */
const providerFromError = (msg: string): string => /\[([^\]]+)\]/.exec(msg)?.[1] ?? "?";

/** Jedno podejście: odpowiedź modelu (albo null) plus dostawca, KTÓRY ją obsłużył. */
async function attempt(
  api: Api, label: string, schema: unknown, prompt: { system: string; user: string },
): Promise<Attempt> {
  api.resetStructured();
  const out = await api.chat({
    model: api.MODEL_EXTRACT, task: "extract", ...prompt, maxTokens: 2000,
    schema: { name: "wydarzenia", schema },
  });
  const rejection = api.structuredRejection();
  // Ustępstwo wypisujemy przy KAŻDYM szczeblu, bo bez tego „PRZYJĘTY" znaczy dwie różne
  // rzeczy — „schemat przeszedł tak, jak go wysyłamy" albo „przeszedł dopiero, gdy adapter
  // odpuścił temperaturę" — a to drugie jest właśnie tym, po co się tu schodzi.
  const dropped = api.temperatureDropped()
    ? "   ↳ dopiero BEZ `temperature` — model jej nie obsługuje na żadnym endpoincie\n"
      + `     (${api.temperatureRejection() ?? "?"})\n`
    : "";
  // Dostawcę wypisujemy ZAWSZE. Bez niego dwa różne wyniki tej samej sondy wyglądają
  // na różnicę w schemacie, a bywają różnicą w routingu — dwa razy pod rząd wyciągnęliśmy
  // z tego zły wniosek, zanim OpenRouter zaczął zdradzać, kto obsłużył request.
  if (rejection) {
    const provider = providerFromError(rejection);
    console.log(`❌ ${label}: ODRZUCONY (dostawca: ${provider})`);
    console.log(`${dropped}   ${rejection}\n`);
    return { out: null, provider };
  }
  const provider = api.servingProvider() ?? "?";
  console.log(`✅ ${label}: PRZYJĘTY (obsłużył: ${provider})`);
  console.log(`${dropped}`);
  return { out, provider };
}

/**
 * Werdykt czytamy dopiero przy `require_parameters: true`, czyli gdy routing jest zawężony
 * do endpointów obsługujących response_format. Bez tego kolejne szczeble sondy trafiały do
 * RÓŻNYCH dostawców i porównywały nieporównywalne — „minimalny przeszedł, pełny nie" znaczyło
 * wtedy „los rzucił je gdzie indziej", a nie „winny jest nasz schemat".
 */
function verdict(full: boolean, minimal: boolean, noFormat: boolean): string {
  if (full) return "Włącz na stałe: STRUCTURED_OUTPUTS=1 w .env";
  if (noFormat) {
    return "Nasz schemat przechodzi PO USUNIĘCIU `format`. Winne jest to jedno słowo kluczowe —\n"
      + "dopisz `format` do zbioru OURS w src/shared/json-schema.ts (obok x-render i default),\n"
      + "wtedy zniknie z drutu, a walidacja lokalna zostanie bez zmian.";
  }
  if (minimal) {
    return "Endpoint obsługuje response_format, ale odbija NASZ schemat (i nie chodzi o `format`).\n"
      + "Zawęź go po komunikacie wyżej — najczęściej `anyOf` albo zagnieżdżenie.";
  }
  return "Żaden endpoint tego modelu nie przyjął schematu.\n\n"
    + "Jeśli w błędzie widzisz „No endpoints found\", to NIE JEST jeszcze werdykt o schemacie.\n"
    + "`require_parameters` przepuszcza tylko endpointy obsługujące WSZYSTKIE parametry\n"
    + "requestu, więc routing wywraca KAŻDY nieobsługiwany parametr z osobna — także taki,\n"
    + "który ze structured outputs nie ma nic wspólnego. Modele rozumujące (reasoning) nie\n"
    + "mają np. `temperature` wcale; adapter sam ją wtedy odpuszcza i próbuje ponownie, więc\n"
    + "jeśli mimo to widzisz ten komunikat, winien jest JESZCZE INNY parametr.\n\n"
    + "Czym różnią się endpointy (strona modelu pokazuje SUMĘ możliwości wszystkich dostawców,\n"
    + "czyli obietnicę, której żaden z osobna nie spełnia):\n"
    + "  curl -s https://openrouter.ai/api/v1/models/<model>/endpoints \\\n"
    + "    | jq '.data.endpoints[] | {name, supported_parameters}'\n\n"
    + "Jest tam response_format? Winny jest inny parametr requestu — porównaj listę z tym, co\n"
    + "wysyła buildBody() w src/adapters/openrouter.ts.\n"
    + "Nie ma? Zostaw STRUCTURED_OUTPUTS wyłączone — blok schematu w prompcie robi tę samą\n"
    + "robotę, tylko bez gwarancji.";
}

async function main(): Promise<void> {
  // Sonda ma sprawdzać ścieżkę ze schematem niezależnie od tego, co stoi w .env — stąd
  // nadpisanie środowiska. Rejestr czyta je leniwie, więc kolejność importów nie ma już
  // znaczenia (dynamiczne `import` niżej zostają, bo nic nie kosztują).
  process.env["STRUCTURED_OUTPUTS"] = "1";
  const api = await import("../adapters/openrouter.js");
  const { extractionSystem } = await import("../pipeline/prompts.js");

  const prompt = {
    system: extractionSystem(new Date().toISOString().slice(0, 10)),
    user: `ŹRÓDŁO: https://example.test/\n\n${SAMPLE}`,
  };
  const wire = toWireSchema(ExtractionSchema);

  console.log(`Model: ${api.MODEL_EXTRACT}\n`);

  const tried: Attempt[] = [];
  const run = async (label: string, schema: unknown, p = prompt): Promise<Attempt> => {
    const a = await attempt(api, label, schema, p);
    tried.push(a);
    return a;
  };

  const full = await run("pełny schemat", wire);
  const out = full.out;
  let minimalOk = false;
  let noFormatOk = false;

  if (!out) {
    const echo = { system: "Jesteś echem.", user: "Odpowiedz: OK" };
    minimalOk = (await run("schemat minimalny", MINIMAL, echo)).out !== null;
    if (minimalOk) {
      noFormatOk = (await run("pełny bez `format`", withoutFormat(wire), prompt)).out !== null;
    }
  }

  const body = out ?? "";
  if (body) {
    const trimmed = body.trim();
    console.log(trimmed.startsWith("{") && trimmed.endsWith("}")
      ? "✅ odpowiedź to goły JSON — regex wyłuskujący przestaje być potrzebny"
      : "⚠️  odpowiedź owinięta w tekst/markdown — regex nadal robi robotę");
    const parsed: unknown = JSON.parse(body.match(/\{[\s\S]*\}/)?.[0] ?? "null");
    const errors = [...Value.Errors(ExtractionSchema, parsed)];
    console.log(errors.length === 0
      ? "✅ odpowiedź przechodzi walidację schematem — bez łatania braków"
      : `⚠️  ${errors.length} odchyleń od schematu:`);
    for (const e of errors.slice(0, 8)) console.log(`     ${e.path || "/"} — ${e.message}`);
  }

  const usage = api.snapshotUsage();
  console.log(`\nKoszt sondy: $${usage.costUsd.toFixed(5)} `
    + `(${usage.promptTokens}+${usage.completionTokens} tok, ${usage.calls} płatnych wywołań;`
    + " odbite na 400 nie kosztują)");
  // Werdykt o schemacie ma sens TYLKO wtedy, gdy wszystkie szczeble obsłużył ten sam
  // dostawca. Inaczej porównujemy różne środowiska i przypisujemy schematowi cudzą winę.
  const providers = [...new Set(tried.map((a) => a.provider))];
  if (out === null && providers.length > 1) {
    console.log(`\n⚠️  Szczeble trafiły do RÓŻNYCH dostawców (${providers.join(", ")}) — `
      + "porównanie jest nieważne.\n"
      + "Odfiltruj tego, który odbija, przez STRUCTURED_IGNORE_PROVIDERS w .env "
      + "(slug małymi literami)\ni uruchom sondę ponownie.");
    return;
  }
  console.log(`\n${verdict(out !== null, minimalOk, noFormatOk)}`);
}

await main();
