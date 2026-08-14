/**
 * Blok = POST, nie zgadnięty kawałek tekstu.
 *
 * Podział na bloki powstał dla stron skrobanych, gdzie `html-to-text` zdążył zniszczyć
 * strukturę kart i granicę trzeba ZGADYWAĆ (hash akapitu modulo N — patrz blocks.ts).
 * Grupa FB jest jedynym wejściem, które przychodzi już podzielone: Bright Data oddaje
 * tablicę postów. `fbGroupPostsToText` sklejał ją w jeden napis, a `segment()` zaraz potem
 * próbował granice odtworzyć — i mylił się dla 125 z 310 postów (przebieg 2026-08-14),
 * czyli tnąc post między tytuł a datę.
 *
 * Te testy pilnują trzech rzeczy naraz:
 *   1. post nigdy nie jest przecięty — cała jego treść stoi w jednym bloku,
 *   2. `fbGroupPostsToText` oddaje DOKŁADNIE to samo co dotąd (hash treści, archiwum
 *      i dowód bezpiecznika liczą się z tego napisu — zmiana zerwałaby cache i ślad),
 *   3. do modelu naprawdę idzie jeden post na „BLOK n:".
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

// przed importem adaptera: klucz czytany jest przez rejestr parametrów, a sieć i tak stoi na atrapie
process.env["OPENROUTER_API_KEY"] = "sk-or-test";

import { suppressArchive } from "../src/adapters/supabase-archive.js";
import { segment } from "../src/pipeline/extract/blocks.js";
import { blockSource } from "../src/pipeline/extract/block-source.js";
import { fbGroupPostsToBlocks, fbGroupPostsToText } from "../src/pipeline/facebook.js";
import type { PipelineState } from "../src/types/index.js";

/**
 * Prawdziwy kształt materiału: udostępnienie, którego oryginał ma PUSTE WIERSZE — a to po
 * nich tnie `paragraphs()`. Tu właśnie rozjeżdżał się tytuł z datą.
 */
const grecki = {
  url: "https://www.facebook.com/groups/imprezypoznan/posts/4077491349052603/",
  content: "Rezerwuj stolik na wyjątkowy Wieczór Grecki.",
  date_posted: "2026-08-03T12:51:57.000Z",
  original_post: {
    post_id: "UzpfSTEwMDA2MzgyOTU2MTg3MDox",
    post_url: "https://www.facebook.com/reel/2155526571657733/",
    user_name: "Hotel HP Park Poznań",
    date: "2026-08-03T10:14:33.000Z",
    content: "🇬🇷 Restauracja Panorama zamieni się w grecką wyspę nad Maltą!\n\n"
      + "W programie:\n🎶 koncert zespołu prosto z Grecji\n🎨 wernisaż malarstwa\n\n"
      + "📅 21 sierpnia 2026, godz. 19:00\n\nZabierzcie bliskich!",
  },
};

const post = (id: string, body: string) => ({
  url: `https://www.facebook.com/groups/imprezypoznan/posts/${id}/`,
  content: body,
  date_posted: "2026-08-11T10:00:00.000Z",
});

const records = [
  grecki,
  post("111", "Zapraszamy na salsę, już jutro na Placu Wolności!\n\nKlub pod Minogą"),
  post("222", "Wanna Wanna Cuban Party — 3 lata nieobecności trzeba nadrobić!"),
  post("333", "Plany na dziś!\n\nSobota 8 Sierpnia\n\nKanał 1 💙 Dj Wosiu\nKanał 2 ❤ Fasti"),
];

describe("fbGroupPostsToBlocks — jeden post, jeden blok", () => {
  const blocks = fbGroupPostsToBlocks(records);

  it("bloków jest tyle, co postów", () => {
    assert.equal(blocks.length, records.length);
  });

  it("każdy blok niesie dokładnie jeden post", () => {
    for (const b of blocks) {
      assert.equal((b.match(/^LINK: /gmu) ?? []).length, 1, `blok z ${b.match(/LINK: \S+/gu)?.length} adresami`);
    }
  });

  it("treść postu nie jest przecięta — data stoi przy swoim adresie", () => {
    const grecki_ = blocks.find((b) => b.includes("4077491349052603"))!;
    assert.match(grecki_, /21 sierpnia 2026, godz. 19:00/);
    assert.match(grecki_, /Rezerwuj stolik/);
  });

  it("blok nie zagarnia sąsiada", () => {
    const salsa = blocks.find((b) => b.includes("/111/"))!;
    assert.doesNotMatch(salsa, /Cuban Party|Wieczór Grecki/);
  });

  /**
   * Napis dla hasza, archiwum i dowodu bezpiecznika ma zostać CO DO ZNAKU ten sam —
   * inaczej jedna zmiana podziału unieważnia cache wszystkich grup i psuje `postsByLink`.
   */
  it("sklejenie bloków to dokładnie dotychczasowy tekst źródła", () => {
    assert.equal(blocks.join("\n\n---\n\n"), fbGroupPostsToText(records));
  });
});

describe("stary podział na tym samym materiale", () => {
  it("tnie posty między akapitami — to jest naprawiany błąd", () => {
    const stare = segment(fbGroupPostsToText(records));
    const linkiWBloku = stare.map((b) => (b.text.match(/^LINK: /gmu) ?? []).length);
    const rozjazd = stare.some((b, i) => linkiWBloku[i] === 0 || linkiWBloku[i]! > 1);
    assert.ok(rozjazd, "fixture przestał obrazować problem — dobierz materiał na nowo");
  });
});

// ---------------- ścieżka blokowa dostaje gotowe bloki ----------------

const realFetch = globalThis.fetch;
let lastPrompt = "";

/** OpenRouter oddaje pustą listę wydarzeń; testowi wystarczy PROMPT, nie odpowiedź. */
function stubLlm(): void {
  lastPrompt = "";
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("openrouter.ai")) return Promise.reject(new TypeError(`nieoczekiwany fetch: ${url}`));
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
    lastPrompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"events":[],"followups":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };
}

beforeEach(() => { suppressArchive(true); stubLlm(); });
afterEach(() => { globalThis.fetch = realFetch; suppressArchive(false); });

describe("blockSource — bloki z rekordów zamiast zgadywania", () => {
  const state = (): PipelineState => ({ hashes: {}, geo: {}, extractions: {}, blocks: {} });

  const fetched = () => ({
    kind: "html" as const,
    text: fbGroupPostsToText(records),
    blocks: fbGroupPostsToBlocks(records),
    httpStatus: 200,
  });

  it("do modelu idzie jeden post na blok", async () => {
    const out = await blockSource(fetched(), "https://www.facebook.com/groups/imprezypoznan", state());
    assert.ok(out, "ścieżka blokowa odmówiła");
    assert.equal(out.blocks.total, records.length);
    const naglowki = lastPrompt.match(/^BLOK \d+:$/gmu) ?? [];
    assert.equal(naglowki.length, records.length);
    for (const kawalek of lastPrompt.split(/^BLOK \d+:$/mu).slice(1)) {
      assert.equal((kawalek.match(/^LINK: /gmu) ?? []).length, 1);
    }
  });

  it("bez gotowych bloków zostaje podział po akapitach — inne źródła bez zmian", async () => {
    const zwykla = { kind: "html" as const, text: fbGroupPostsToText(records), httpStatus: 200 };
    const out = await blockSource(zwykla, "https://gmina.test/wydarzenia", state());
    assert.ok(out);
    assert.equal(out.blocks.total, segment(zwykla.text).length);
  });
});
