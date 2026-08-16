/**
 * Drabinka ustępstw przy odbiciu requestu ze schematem (`negotiate()` w openrouter.ts).
 *
 * PO CO TO ISTNIEJE. `provider.require_parameters` przepuszcza tylko endpointy obsługujące
 * WSZYSTKIE parametry requestu, więc routing wywraca go przez KAŻDY nieobsługiwany parametr
 * z osobna — także taki, który ze structured outputs nie ma nic wspólnego. Modele rozumujące
 * nie mają `temperature` wcale i 2026-08-16 kosztowało to cały przebieg bez schematu:
 * pierwsze wywołanie dostało „404 No endpoints found", a potok odczytał to jako „model nie
 * umie schematu" i zgasił go na resztę procesu. Umiał — nie umiał temperatury.
 *
 * Testujemy więc nie „czy jest retry", tylko CZY ODDAJEMY WŁAŚCIWĄ RZECZ: najpierw
 * powtarzalność jednego wywołania, a dopiero potem gwarancję kształtu odpowiedzi na cały
 * proces. Pomyłka w tej kolejności jest niewidoczna — przebieg kończy się zielono i dopiero
 * rachunek albo krzywe JSON-y mówią, że coś oddaliśmy za darmo.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

process.env["OPENROUTER_API_KEY"] = "sk-or-test";

const {
  chat, resetStructured, structuredActive, temperatureDropped,
} = await import("../src/adapters/openrouter.js");

const realFetch = globalThis.fetch;

interface Sent { schema: boolean; temperature: unknown; hasTemperature: boolean }

/** Ciała kolejnych requestów — po nich poznajemy, co dokładnie oddaliśmy i w jakiej kolejności. */
let sent: Sent[] = [];

const good = {
  choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
  usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 },
};

const ROUTING_404 = "No endpoints found that can handle the requested parameters.";

/**
 * `replies` to kolejne odpowiedzi na kolejne wywołania: `null` = OK, string = komunikat
 * błędu routingu (404). Ostatnia powtarza się, gdyby wywołań było więcej niż zaplanowano.
 */
function stub(replies: Array<string | null>): void {
  let i = 0;
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // buildBody() zawsze podaje string; zawężenie jest po to, żeby typ się zgadzał z fetch
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as Record<string, unknown>;
    sent.push({
      schema: "response_format" in body,
      temperature: body["temperature"],
      hasTemperature: "temperature" in body,
    });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === null || reply === undefined) {
      return Promise.resolve(new Response(JSON.stringify(good), { status: 200 }));
    }
    return Promise.resolve(new Response(
      JSON.stringify({ error: { message: reply } }), { status: 404 },
    ));
  };
}

const call = (): Promise<string> => chat({
  model: "test/reasoning-model", task: "extract", system: "s", user: "u", temperature: 0,
  schema: { name: "wydarzenia", schema: { type: "object" } },
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sent = [];
  resetStructured();
});

describe("routing odbija parametr, nie schemat", () => {
  it("powtarza BEZ temperature, ale WCIĄŻ ze schematem — o niego chodzi", async () => {
    stub([ROUTING_404, null]);
    await call();

    assert.equal(sent.length, 2, "jedno odbicie i jedna poprawiona próba");
    assert.deepEqual(
      { schema: sent[0]?.schema, temp: sent[0]?.hasTemperature },
      { schema: true, temp: true },
      "pierwsza próba idzie tak, jak chcieliśmy: ze schematem i z temperaturą",
    );
    assert.deepEqual(
      { schema: sent[1]?.schema, temp: sent[1]?.hasTemperature },
      { schema: true, temp: false },
      "druga oddaje TYLKO temperaturę — schemat zostaje",
    );
    assert.equal(structuredActive(), true, "schemat nie może zgasnąć przez cudzy parametr");
    assert.equal(temperatureDropped(), true);
  });

  it("odpuszczenie temperatury jest trwałe — kolejne wywołania nie płacą już za odbicie",
    async () => {
      stub([ROUTING_404, null]);
      await call();
      const afterFirst = sent.length;

      await call();

      assert.equal(sent.length - afterFirst, 1,
        "drugie wywołanie idzie za pierwszym razem, bez powtórki od 404");
      assert.equal(sent.at(-1)?.hasTemperature, false);
      assert.equal(sent.at(-1)?.schema, true, "schemat wciąż na drucie");
    });

  it("gdy i bez temperatury nie przechodzi, schodzi szczebel niżej — bez schematu",
    async () => {
      stub([ROUTING_404, ROUTING_404, null]);
      await call();

      assert.equal(sent.length, 3);
      assert.equal(sent[1]?.schema, true, "szczebel 1 próbuje jeszcze ze schematem");
      assert.equal(sent[2]?.schema, false, "dopiero szczebel 2 oddaje schemat");
      assert.equal(structuredActive(), false, "i gasi go na resztę procesu");
    });

  it("odmowa NIE-routingowa idzie prosto do schematu — temperatura jest tu niewinna",
    async () => {
      // tak odbijał Haiku: przeciążenie dostawcy, nie niezgodność parametrów
      stub(["Provider returned error — Overloaded", null]);
      await call();

      assert.equal(sent.length, 2);
      assert.equal(sent[1]?.schema, false, "od razu bez schematu — nie ma czego szukać w parametrach");
      assert.equal(sent[1]?.hasTemperature, true, "temperatura zostaje, bo nikt jej nie zakwestionował");
      assert.equal(temperatureDropped(), false);
    });

  it("temperatura 0 z ekstrakcji dociera na drut — domyślne 0.2 jej nie nadpisuje", async () => {
    stub([null]);
    await call();

    assert.equal(sent[0]?.temperature, 0,
      "`?? 0.2` łapie tylko brak parametru; 0 jest wyborem, nie brakiem");
  });
});
