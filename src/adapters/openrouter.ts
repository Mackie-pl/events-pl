/**
 * Cienki klient OpenRouter (OpenAI-compatible chat completions).
 * Modele wybierane przez env — łatwa ewaluacja różnych modeli bez zmian w kodzie:
 *   OPENROUTER_API_KEY  (wymagany)
 *   MODEL_EXTRACT       default: anthropic/claude-haiku-4.5   (tani, codzienna ekstrakcja)
 *   MODEL_DISCOVER      default: anthropic/claude-sonnet-4.6  (mocny, miesięczne discovery)
 */

import { fetchUrl } from "./http.js";
import { P } from "../config/index.js";
import { audit } from "../shared/audit.js";
import { describeError } from "../shared/errors.js";
import type { AuditDetail, LlmTask, LlmUsage, TaskUsage } from "../types/index.js";

// Wybór modelu zapada raz na proces — te dwie stałe są świadomie czytane przy ładowaniu
// modułu, żeby nie przerabiać czternastu miejsc użycia na wywołania. Reszta parametrów
// czyta się leniwie (patrz config/param.ts).
export const MODEL_EXTRACT = P.MODEL_EXTRACT.get();
export const MODEL_DISCOVER = P.MODEL_DISCOVER.get();

/**
 * Akumulator zużycia LLM. Wywołania chat() są sekwencyjne (await) — bez współbieżności,
 * więc prosty licznik modułowy wystarcza. daily.ts robi resetUsage() przed każdym źródłem
 * i snapshotUsage() po, żeby przypisać tokeny/koszt do konkretnego źródła.
 */
const tally: LlmUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
/**
 * Ten sam licznik z podziałem na rodzaj zadania. Rachunek OpenRoutera zna tylko model,
 * a „Haiku" to zarówno tekst strony, jak i plakat (wejście multimodalne) — dwie pozycje
 * o różnych stawkach za wejście i o zupełnie różnych przyczynach wzrostu.
 */
const byTask = new Map<LlmTask, LlmUsage>();

export function resetUsage(): void {
  tally.calls = 0;
  tally.promptTokens = 0;
  tally.completionTokens = 0;
  tally.costUsd = 0;
  byTask.clear();
}

export function snapshotUsage(): LlmUsage {
  return { ...tally };
}

/** Zużycie w rozbiciu na zadania — tylko te, które w tym oknie wystąpiły. */
export function snapshotTasks(): TaskUsage {
  const out: TaskUsage = {};
  for (const [task, usage] of byTask) out[task] = { ...usage };
  return out;
}

function addTask(task: LlmTask, usage: { promptTokens: number; completionTokens: number; costUsd: number }): void {
  const cur = byTask.get(task) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  cur.calls += 1;
  cur.promptTokens += usage.promptTokens;
  cur.completionTokens += usage.completionTokens;
  cur.costUsd += usage.costUsd;
  byTask.set(task, cur);
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
export type UserContent = string | Array<TextPart | ImagePart>;

export interface ChatOptions {
  model: string;
  /** rodzaj zadania — nośnik podziału kosztów (costs.json), nie da się go odtworzyć z modelu */
  task: LlmTask;
  system: string;
  user: UserContent;
  maxTokens?: number;
  temperature?: number;
  /** JSON Schema wymuszony na odpowiedzi (structured outputs); brak = zwykły tekst */
  schema?: { name: string; schema: unknown };
  /**
   * Adres obrazu, który poszedł do modelu jako base64. NIE idzie do dostawcy — służy
   * wyłącznie archiwum: bajtów plakatu nie zapisujemy (megabajty base64 za jedno wywołanie),
   * więc bez adresu w archiwum zostawał sam licznik „[obraz pominięty — 440 kB]" i nie dało
   * się zobaczyć, CO model właściwie oglądał. Adres waży kilkaset bajtów i pokazuje to samo,
   * dopóki nie wygaśnie podpis w CDN-ie.
   */
  imageSrc?: string;
}

/**
 * Structured outputs (`response_format: json_schema`) — WŁĄCZONE domyślnie od 2026-08-01.
 *
 * Były wyłączone, dopóki nikt nie zapłacił za sprawdzenie. Sonda (`npm run check:structured`,
 * $0.0041) pokazała: schemat przyjęty przez Anthropic, odpowiedź to goły JSON, przechodzi
 * walidację bez łatania braków. Rozstrzygnął jednak dopiero pomiar na prawdziwym źródle —
 * `estrada.poznan.pl` zwracała 8 wydarzeń bez schematu i 25 z nim.
 *
 * Powód jest konkretny i będzie wracał: model przepisuje typografię strony i wypuszcza
 * `"title": "Spacer „Okrąglak – eksperyment modernizmu" z dr hab. ..."` — polski cudzysłów
 * otwierający, ASCII zamykający, czyli string JSON-a urwany w środku wartości. Żaden prompt
 * tego nie gwarantuje; `response_format` gwarantuje.
 *
 * Wyłącznik zostaje (`STRUCTURED_OUTPUTS=0`), bo MODEL_EXTRACT jest podmieniany z .env,
 * a obsługa zależy od modelu I od dostawcy, na którego zrouteruje OpenRouter. Odbicie
 * schematu i tak gasi flagę na resztę procesu (patrz `structuredOff` niżej).
 *
 * Zawężenie dostawców (`STRUCTURED_IGNORE_PROVIDERS`) działa tylko na ścieżce ze schematem —
 * zwykłe wywołania dalej routują się swobodnie, żeby nie tracić dostępności tam, gdzie
 * problemu nie ma. Po co domyślnie `azure`: patrz src/config/params.ts.
 */

/**
 * Model odmówił schematu — do końca procesu jedziemy bez niego. Flaga jest modułowa
 * i JEDNOKIERUNKOWA: gdyby wracała do stanu wyjściowego, każde źródło płaciłoby własne
 * odbicie od 400, a przy kilkudziesięciu źródłach to kilkadziesiąt zmarnowanych wywołań.
 */
let structuredOff = false;

/**
 * Model nie przyjmuje `temperature` — do końca procesu wysyłamy request bez niej.
 * Flaga modułowa i JEDNOKIERUNKOWA z tego samego powodu co `structuredOff`: inaczej
 * każde źródło płaciłoby własne odbicie od routingu (400/404 nie zużywa tokenów, ale
 * kosztuje pełny round-trip, a przy kilkudziesięciu wywołaniach to kilkadziesiąt).
 *
 * PO CO OSOBNO OD `structuredOff`, skoro objawia się tylko na ścieżce ze schematem.
 * Bo to NIE JEST odmowa schematu. `require_parameters` przepuszcza wyłącznie endpointy
 * obsługujące WSZYSTKIE parametry requestu, więc routing wywraca każdy nieobsługiwany
 * parametr z osobna — także taki, który ze structured outputs nie ma nic wspólnego.
 * Modele rozumujące (reasoning) nie mają `temperature` wcale: 2026-08-16 cały przebieg
 * na openai/gpt-5.6-luna poszedł bez schematu, bo pierwsze wywołanie dostało
 * „404 No endpoints found", a my odczytaliśmy to jako „model nie umie schematu".
 * Umiał — sześć z siedmiu endpointów deklaruje response_format. Nie umiał temperatury.
 *
 * Co endpoint naprawdę obsługuje, mówi tylko rozbicie per endpoint (strona modelu pokazuje
 * SUMĘ możliwości wszystkich dostawców, czyli obietnicę, której żaden z osobna nie spełnia):
 *   curl -s https://openrouter.ai/api/v1/models/<model>/endpoints \
 *     | jq '.data.endpoints[] | {name, supported_parameters}'
 */
let temperatureOff = false;

/** Komunikat routingu, który kazał odpuścić `temperature` — dla sondy i śladu. */
let temperatureError: string | null = null;

/**
 * Odbicie od routingu, a nie od schematu. OpenRouter mówi to jednym zdaniem i tylko przy
 * `require_parameters`, więc dopasowanie do komunikatu jest tu jedynym dostępnym sygnałem —
 * kod HTTP (404) dzieli z „nie ma takiego modelu", którego retry naprawić nie może.
 */
const isRoutingRejection = (msg: string): boolean => /no endpoints found/i.test(msg);

/**
 * Komunikat, którym dostawca odbił schemat. Trzymamy go osobno od śladu decyzyjnego:
 * ślad zbiera się per źródło i per przebieg, a sonda (`npm run check:structured`) działa
 * poza przebiegiem i bez niego nie miałaby czego pokazać — czyli mówiłaby „odrzucony"
 * i nie mówiła DLACZEGO, a to jedyna informacja, po którą się ją uruchamia.
 */
let structuredError: string | null = null;

/**
 * Dostawca, który obsłużył ostatnie wywołanie. Nie ozdoba: routing OpenRoutera potrafi
 * przerzucić ten sam model między Anthropic, Azure i Bedrockiem, a różnią się one obsługą
 * parametrów — bez tej informacji błąd jednego z nich wygląda na błąd naszego requestu.
 */
let lastProvider: string | null = null;

/**
 * Powód zatrzymania ostatniego wywołania. Modułowy jak `lastProvider` i z tego samego
 * powodu: `chat()` zwraca sam tekst i tak używa go kilkanaście miejsc, a rozszerzenie
 * zwracanego typu przepisałoby każde z nich. Wywołania są sekwencyjne (await), więc
 * „ostatnie" jest jednoznaczne — czytaj TUŻ po `chat()`.
 */
let lastFinish: string | null = null;

/**
 * Rachunek za ostatnie wywołanie i miejsce, gdzie wylądował jego prompt. Modułowe z tego
 * samego powodu, co `lastProvider`: `chat()` oddaje sam tekst, a krok śladu emituje wywołujący
 * (extract.ts), który usage nigdy nie widział. Bez tego ślad mówił „model policzył 25 wydarzeń"
 * i nie mówił ani ile to kosztowało, ani gdzie przeczytać, o co model był zapytany — czyli
 * dokładnie te dwie rzeczy, po które schodzi się do śladu, gdy wynik wygląda podejrzanie.
 */
let lastUsage: LlmCallRecord["usage"] | null = null;
let lastArchive: string | null = null;

export const structuredActive = (): boolean => P.STRUCTURED_OUTPUTS.get() && !structuredOff;
export const structuredRejection = (): string | null => structuredError;
/** Czy odpuściliśmy `temperature`, żeby routing w ogóle wpuścił request ze schematem. */
export const temperatureDropped = (): boolean => temperatureOff;
export const temperatureRejection = (): string | null => temperatureError;
export const servingProvider = (): string | null => lastProvider;
export const finishReason = (): string | null => lastFinish;
/** Czy ostatnia odpowiedź została ucięta na `max_tokens` — a nie skończona przez model. */
export const wasTruncated = (): boolean => lastFinish === "length";

/**
 * Rozliczenie ostatniego wywołania w formie detali kroku śladu. Jedna funkcja zamiast
 * powtórzonych kluczy w każdym miejscu audytującym „llm": rozjazd nazw zamieniłby ślad
 * w zgadywankę, który klucz gdzie znaczy cenę. Czytaj TUŻ po `chat()`, jak `wasTruncated()`.
 *
 * Puste, gdy wywołanie padło (nie ma za co płacić) albo gdy archiwum jest wyłączone —
 * brak klucza jest tu informacją, nie luką: `usd` bez `archive` znaczy „zapłacone,
 * ale promptu nikt nie zapisał".
 */
export function callDetail(): AuditDetail {
  return {
    ...(lastUsage
      ? {
          usd: lastUsage.costUsd,
          tokIn: lastUsage.promptTokens,
          tokOut: lastUsage.completionTokens,
        }
      : {}),
    ...(lastArchive ? { archive: lastArchive } : {}),
  };
}

/** Tylko dla sondy i testów: pozwala spróbować innego schematu w tym samym procesie. */
export function resetStructured(): void {
  structuredOff = false;
  structuredError = null;
  // Razem ze schematem, bo sonda schodzi po szczeblach i musi startować z tego samego
  // miejsca co przebieg — inaczej drugi szczebel leciałby już bez temperatury i porównywał
  // nieporównywalne, dokładnie tak jak przy różnych dostawcach (patrz check-structured.ts).
  temperatureOff = false;
  temperatureError = null;
}

/** Pełne wejście/wyjście jednego wywołania — do prywatnego archiwum (archive.ts). */
export interface LlmCallRecord {
  model: string;
  task: LlmTask;
  system: string;
  user: UserContent;
  response: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  ms: number;
  ok: boolean;
  err?: string;
  /** powód zatrzymania (`stop`/`length`) — w archiwum odróżnia „model tak uznał" od „ucięliśmy go" */
  finish?: string;
  /** adres obrazu wysłanego jako base64 — patrz `ChatOptions.imageSrc` */
  imageSrc?: string;
}

/**
 * Hook obserwacyjny. llm.ts nie wie nic o archiwum (brak zależności cyklicznej) —
 * daily.ts podpina recorder tylko wtedy, gdy archiwum jest skonfigurowane.
 * Recordery są wywoływane best-effort: ich błąd nie może wywrócić wywołania LLM.
 *
 * Zwrócony string = miejsce, w którym recorder odłożył wywołanie (ścieżka w archiwum).
 * Trafia do `callDetail()`, żeby krok śladu mógł zalinkować prompt zamiast tylko o nim
 * wspominać. Recorder, który nigdzie nie odkłada (sonda trzyma wywołania w pamięci),
 * dalej zwraca `void` i nic nie musi wiedzieć o tym polu.
 */
export type CallRecorder = (rec: LlmCallRecord) => void | string | null
  | Promise<void | string | null>;

let recorder: CallRecorder | null = null;

export function setCallRecorder(fn: CallRecorder | null): void {
  recorder = fn;
}

async function record(rec: LlmCallRecord): Promise<void> {
  if (!recorder) return;
  try {
    const where = await recorder(rec);
    if (typeof where === "string") lastArchive = where;
  } catch (e) {
    console.warn(`recorder LLM: ${String(e)}`);
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    /**
     * `stop` = model skończył sam, `length` = ucięliśmy go na `max_tokens`. Bez tego pola
     * ucięta odpowiedź dociera wyżej jako zwykły string i wygląda na kompletną — potok
     * zgłasza wtedy „niepoprawny JSON", czyli wskazuje prompt zamiast limitu.
     */
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  /** kto FAKTYCZNIE obsłużył request — ten sam model bywa serwowany z kilku źródeł */
  provider?: string;
  error?: {
    message?: string;
    code?: number;
    /**
     * Oryginalna odpowiedź dostawcy. OpenRouter w `message` wstawia często zaślepkę
     * („Provider returned error") i cała treść błędu — np. które pole schematu jest nie tak —
     * siedzi wyłącznie tutaj. Bez tego debugowanie sprowadza się do zgadywania.
     */
    metadata?: { raw?: unknown; provider_name?: string };
  };
}

/** Komunikat błędu wraz z tym, co powiedział sam dostawca. */
function errorText(json: ChatCompletionResponse): string {
  const base = json.error?.message ?? "unknown error";
  const raw = json.error?.metadata?.raw;
  if (raw === undefined || raw === null) return base;
  const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
  const provider = json.error?.metadata?.provider_name;
  return `${base}${provider ? ` [${provider}]` : ""} — ${detail.slice(0, 500)}`;
}

const NO_USAGE = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

function buildBody(opts: ChatOptions, withSchema: boolean): string {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4000,
    // zwróć koszt (USD) i tokeny w polu usage
    usage: { include: true },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  // Temperatura jest PREFERENCJĄ, nie warunkiem: bez niej ekstrakcja dalej działa, tylko
  // mniej powtarzalnie. Przy `require_parameters` przestawała nią być — jeden parametr,
  // którego model nie zna, kasował wszystkie endpointy i zabierał ze sobą schemat, który
  // z temperaturą nie ma nic wspólnego. Dlatego odpuszczamy ją, gdy routing tak każe.
  if (!temperatureOff) body["temperature"] = opts.temperature ?? 0.2;
  if (withSchema && opts.schema) {
    // strict: bez tego dostawca traktuje schemat jak podpowiedź, a nie kontrakt
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema },
    };
    /**
     * Ten sam model OpenRouter serwuje z kilku źródeł (Anthropic, Azure, Bedrock, Vertex)
     * i domyślnie wybiera je po dostępności — a structured outputs obsługuje tylko część.
     * Bez tego request wpada losowo na endpoint bez obsługi i wraca 400, co wygląda
     * jak błąd naszego schematu i nim NIE jest.
     *
     * Dwa zawężenia, bo jedno nie wystarcza:
     *   require_parameters — routing tylko do endpointów DEKLARUJĄCYCH obsługę parametrów,
     *   ignore — bo deklaracja to nie to samo co uprawnienie. Azure zgłasza obsługę
     *     response_format, ale odbija ją na poziomie konta („structured_outputs not supported
     *     in your workspace"); tego OpenRouter nie widzi i sam nie odfiltruje.
     *
     * Lista jest w .env, bo to własność KONTA, nie modelu — u kogoś innego Azure zadziała.
     */
    const ignore = P.STRUCTURED_IGNORE_PROVIDERS.get();
    body["provider"] = {
      require_parameters: true,
      ...(ignore.length ? { ignore } : {}),
    };
  }
  return JSON.stringify(body);
}

/** Jedno wywołanie HTTP wraz z rozpakowaniem odpowiedzi. Rzuca z gotowym komunikatem. */
async function callOnce(
  apiKey: string, opts: ChatOptions, withSchema: boolean,
): Promise<ChatCompletionResponse> {
  const res = await fetchUrl(P.OPENROUTER_URL.get(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // rankingi/atrybucja OpenRouter (opcjonalne, ale mile widziane):
      "HTTP-Referer": "https://github.com/Mackie-pl/events-pl",
      "X-Title": "events-pl",
    },
    body: buildBody(opts, withSchema),
  }, 120_000, `OpenRouter ${opts.model}`);

  const raw = await res.text();
  let json: ChatCompletionResponse;
  try {
    json = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    // np. strona błędu 502 od proxy zamiast JSON-a
    throw new Error(`OpenRouter ${opts.model}: HTTP ${res.status}, nie-JSON: ${raw.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(`OpenRouter ${opts.model}: HTTP ${res.status}: ${errorText(json)}`);
  }
  return json;
}

/**
 * Drabinka ustępstw: od najtańszego do najdroższego w skutkach. Kolejność NIE jest dowolna —
 * `temperature` kosztuje powtarzalność JEDNEGO wywołania, a schemat gwarancję kształtu
 * odpowiedzi na CAŁY proces (flagi są jednokierunkowe). Do 2026-08-16 drabinki nie było
 * i pierwsze odbicie oddawało od razu to drugie, żeby nie ruszać pierwszego.
 *
 * Rzuca błędem OSTATNIEGO szczebla — wcześniejsze i tak są tylko diagnozą po drodze.
 */
async function negotiate(
  apiKey: string, opts: ChatOptions,
): Promise<ChatCompletionResponse> {
  const withSchema = opts.schema !== undefined && structuredActive();
  try {
    return await callOnce(apiKey, opts, withSchema);
  } catch (e) {
    if (!withSchema) throw e;

    // Szczebel 1: routing odbił request przez PARAMETR, nie przez schemat. Odpuszczamy
    // temperaturę i próbujemy jeszcze raz ZE SCHEMATEM — o niego cała ta gimnastyka chodzi.
    if (!temperatureOff && isRoutingRejection(describeError(e))) {
      temperatureOff = true;
      temperatureError = describeError(e);
      audit("llm", `routing odrzucił parametry — dalej bez temperature (${temperatureError})`,
        { model: opts.model, task: opts.task });
      try {
        return await callOnce(apiKey, opts, true);
      } catch {
        // schemat dalej nie przechodzi — schodzimy szczebel niżej, już bez niego
      }
    }

    // Szczebel 2: schematu nie da się przepchnąć. Nie wywracamy przebiegu z tego powodu —
    // schemat jest ulepszeniem, a nie warunkiem działania: potok potrafi czytać odpowiedź
    // bez niego od zawsze. Gasimy flagę i powtarzamy raz, bez schematu.
    structuredOff = true;
    structuredError = describeError(e);
    audit("llm", `model odrzucił structured outputs — dalej bez schematu (${structuredError})`,
      { model: opts.model, task: opts.task });
    return await callOnce(apiKey, opts, false);
  }
}

export async function chat(opts: ChatOptions): Promise<string> {
  const apiKey = P.OPENROUTER_API_KEY.get();
  if (!apiKey) throw new Error("Brak OPENROUTER_API_KEY");

  const t0 = performance.now();
  // zerujemy PRZED wywołaniem: po awarii nie wolno oddać powodu z poprzedniego wywołania
  // — ani, co gorsza, przykleić do darmowego kroku ceny tego, co płaciliśmy wcześniej
  lastFinish = null;
  lastUsage = null;
  lastArchive = null;
  const base = {
    model: opts.model, task: opts.task, system: opts.system, user: opts.user,
    ...(opts.imageSrc ? { imageSrc: opts.imageSrc } : {}),
  };
  const ms = (): number => Math.round(performance.now() - t0);
  // nieudane wywołania archiwizujemy tak samo jak udane — to one wymagają debugowania
  const failed = async (err: string): Promise<void> =>
    record({ ...base, response: "", usage: NO_USAGE, ms: ms(), ok: false, err });

  let json: ChatCompletionResponse;
  try {
    json = await negotiate(apiKey, opts);
  } catch (e) {
    await failed(describeError(e));
    throw e;
  }

  lastProvider = json.provider ?? null;
  lastFinish = json.choices?.[0]?.finish_reason ?? null;
  const usage = {
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    costUsd: json.usage?.cost ?? 0,
  };
  lastUsage = usage;
  tally.calls += 1;
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
  tally.costUsd += usage.costUsd;
  addTask(opts.task, usage);

  const response = json.choices?.[0]?.message?.content ?? "";
  await record({
    ...base, response, usage, ms: ms(), ok: true,
    ...(lastFinish ? { finish: lastFinish } : {}),
  });
  return response;
}

/** Obraz (plakat) jako data-URL do części multimodalnej. */
export function imagePart(base64: string, mediaType: "image/jpeg" | "image/png"): ImagePart {
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } };
}
