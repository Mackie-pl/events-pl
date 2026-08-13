/**
 * Rachunek za wywołanie modelu w śladzie decyzyjnym (`callDetail()`).
 *
 * Cena i tokeny wracają z OpenRoutera do licznika w openrouter.ts, a krok śladu emituje
 * extract.ts — dwa różne miejsca, które łączy wyłącznie stan modułowy. Testujemy to, co
 * ten stan może zepsuć w sposób NIEWIDOCZNY: nie brak ceny (to widać od razu), tylko cenę
 * PRZYKLEJONĄ do cudzego kroku, gdy wywołanie padło albo w ogóle się nie odbyło. Taki ślad
 * kłamie zamiast milczeć, a to gorszy stan niż jego brak.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

process.env["OPENROUTER_API_KEY"] = "sk-or-test";

const { callDetail, chat, setCallRecorder } = await import("../src/adapters/openrouter.js");

const realFetch = globalThis.fetch;

const ok = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

/** Odpowiedź OpenRoutera z zadanym rachunkiem; `null` = wywołanie się wywraca. */
function stubFetch(usage: { cost: number; prompt: number; completion: number } | null): void {
  globalThis.fetch = () => {
    if (!usage) return Promise.reject(new Error("ECONNRESET"));
    return ok({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: {
        cost: usage.cost, prompt_tokens: usage.prompt, completion_tokens: usage.completion,
      },
    });
  };
}

const call = (): Promise<string> =>
  chat({ model: "test/model", task: "extract", system: "s", user: "u" });

afterEach(() => {
  globalThis.fetch = realFetch;
  setCallRecorder(null);
});

describe("callDetail — rachunek ostatniego wywołania", () => {
  it("niesie cenę i tokeny prosto z usage odpowiedzi", async () => {
    stubFetch({ cost: 0.0041, prompt: 12_000, completion: 800 });
    await call();

    assert.deepEqual(callDetail(), { usd: 0.0041, tokIn: 12_000, tokOut: 800 });
  });

  it("dokłada ścieżkę archiwum, którą oddał recorder — to ona robi z kroku link", async () => {
    stubFetch({ cost: 0.001, prompt: 10, completion: 5 });
    setCallRecorder(() => "llm/2026-08-13/run/zamek/0001-test_model.json");
    await call();

    assert.equal(callDetail()["archive"], "llm/2026-08-13/run/zamek/0001-test_model.json");
  });

  it("bez ścieżki od recordera zostaje sama cena — archiwum bywa wyłączone", async () => {
    stubFetch({ cost: 0.001, prompt: 10, completion: 5 });
    setCallRecorder(() => { /* sonda trzyma wywołania w pamięci i nic nie oddaje */ });
    await call();

    assert.equal("archive" in callDetail(), false);
  });

  it("po nieudanym wywołaniu cena znika, a ścieżka wskazuje TO wywołanie, nie poprzednie",
    async () => {
      // recorder oddaje kolejne ścieżki, bo archiwizujemy też wywołania nieudane — to one
      // wymagają debugowania, więc krok ma prowadzić do zapisu awarii, nie do sukcesu sprzed chwili
      let seq = 0;
      setCallRecorder(() => `llm/2026-08-13/run/zamek/000${++seq}-test_model.json`);

      stubFetch({ cost: 0.0041, prompt: 12_000, completion: 800 });
      await call();
      assert.equal(callDetail()["archive"], "llm/2026-08-13/run/zamek/0001-test_model.json");

      stubFetch(null);
      await assert.rejects(call());

      assert.deepEqual(callDetail(), {
        archive: "llm/2026-08-13/run/zamek/0002-test_model.json",
      }, "za padnięte wywołanie nie ma czego policzyć — zostaje sam zapis awarii");
    });

  it("brak pola usage u dostawcy daje zera, nie rachunek sprzed chwili", async () => {
    stubFetch({ cost: 0.0041, prompt: 12_000, completion: 800 });
    await call();

    globalThis.fetch = () => ok({ choices: [{ message: { content: "{}" } }] });
    await call();

    assert.deepEqual(callDetail(), { usd: 0, tokIn: 0, tokOut: 0 });
  });
});
