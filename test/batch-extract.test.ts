/**
 * Wywołanie zbiorcze: jedno zapytanie na wiele bloków, wynik rozpisany po numerach.
 *
 * Testujemy części CZYSTE — składanie promptu i rozpisywanie odpowiedzi — bo to w nich
 * mieszka cała nowa logika. Samego wywołania modelu nie ruszamy; od tego jest `test:live`.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Value } from "@sinclair/typebox/value";

import { fillMissing } from "../src/shared/json-schema.js";
import { chunk } from "../src/pipeline/extract/block-source.js";
import { mapBatch, withHeaders } from "../src/pipeline/extract/extract.js";
import { batchExtractionSystem, extractionSystem } from "../src/pipeline/prompts.js";
import { BlockEventSchema, EventSchema } from "../src/types/event-schema.js";

describe("prompt zbiorczy", () => {
  /**
   * Wydzielenie wspólnych reguł do stałej miało być refaktorem bez zmiany treści.
   * Prompt jest wejściem modelu, więc „bez zmiany" znaczy CO DO ZNAKU — inaczej
   * porównywanie jakości sprzed i po przestaje cokolwiek znaczyć.
   */
  it("nie zmienił promptu pojedynczego ani o znak", () => {
    const s = extractionSystem("2026-08-07");
    assert.equal(s.length, 3141, "długość promptu pojedynczego się zmieniła");
    assert.ok(s.startsWith("Wyciągasz wydarzenia lokalne z tekstu strony/PDF-a. Dziś jest 2026-08-07."));
    assert.ok(s.includes("BEZ DATY = NIE WYDARZENIE."));
    assert.ok(!s.includes("BLOK"), "prompt pojedynczy nie ma prawa wspominać o blokach");
  });

  it("dzieli te same reguły, co pojedynczy", () => {
    const single = extractionSystem("2026-08-07");
    const batch = batchExtractionSystem("2026-08-07");
    for (const rule of ["WYDARZENIA-KONTENERY:", "WYDARZENIA CYKLICZNE:", "BEZ DATY = NIE WYDARZENIE."]) {
      assert.ok(single.includes(rule) && batch.includes(rule), `reguła „${rule}" rozjechała się`);
    }
  });

  it("każe podpisać wpisy numerem bloku", () => {
    const batch = batchExtractionSystem("2026-08-07");
    assert.ok(batch.includes('"block"'), "prompt nie wspomina pola block");
    assert.ok(batch.includes("BLOK n:"), "prompt nie tłumaczy, skąd wziąć numer");
  });
});

describe("rozpisanie odpowiedzi na bloki", () => {
  const ev = (block: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ title: `W${block}`, date_start: "2026-09-01", block, ...over });

  it("wpis trafia do bloku o swoim numerze", () => {
    const r = mapBatch([ev(0), ev(2), ev(2)], [], 3, false);
    assert.deepEqual(r.byBlock.get(0)!.events.map((e) => e.title), ["W0"]);
    assert.deepEqual(r.byBlock.get(1)!.events, []);
    assert.equal(r.byBlock.get(2)!.events.length, 2);
    assert.equal(r.kept, 3);
  });

  it("zdejmuje numer bloku, więc wpis przechodzi walidację", () => {
    const r = mapBatch([ev(0)], [], 1, false);
    const kept = r.byBlock.get(0)!.events[0]!;
    assert.equal(kept.title, "W0");
    assert.ok(!("block" in kept), "numer bloku wyciekł do opublikowanego wydarzenia");
  });

  it("wpis bez numeru albo z numerem spoza paczki przepada, nie trafia do przypadkowego bloku", () => {
    const bez = { title: "sierota", date_start: "2026-09-01" };
    const r = mapBatch([bez, ev(9), ev(-1), ev(0)], [], 2, false);
    assert.equal(r.orphans, 3);
    assert.equal(r.kept, 1);
    assert.deepEqual(r.byBlock.get(0)!.events.map((e) => e.title), ["W0"]);
    assert.deepEqual(r.byBlock.get(1)!.events, []);
  });

  it("followupy też idą za numerem bloku i nie dublują się", () => {
    const r = mapBatch([], [
      { url: "/a.pdf", reason: "program PDF", block: 1 },
      { url: "/a.pdf", reason: "program PDF", block: 1 },
      { url: "/b.pdf", reason: "plakat", block: 0 },
    ] as never, 2, false);
    assert.deepEqual(r.byBlock.get(0)!.followups, ["/b.pdf"]);
    assert.deepEqual(r.byBlock.get(1)!.followups, ["/a.pdf"]);
  });

  it("zdrowa odpowiedź nie oznacza żadnego bloku jako niepewny", () => {
    assert.equal(mapBatch([ev(0), ev(1)], [], 3, false).unsafe.size, 0);
  });

  /**
   * Zapisanie uciętego ogona jako „zero wydarzeń" zatruwałoby cache: blok zostałby uznany
   * za przeczytany i nigdy nie wróciłby do modelu. Pewny jest tylko blok, po którym model
   * zdążył przejść do NASTĘPNEGO.
   */
  it("po ucięciu odpowiedzi ostatni widziany blok i cała reszta są niepewne", () => {
    const r = mapBatch([ev(0), ev(1), ev(2)], [], 6, true);
    assert.deepEqual([...r.unsafe].sort((a, b) => a - b), [2, 3, 4, 5]);
    assert.ok(!r.unsafe.has(0) && !r.unsafe.has(1), "bloki domknięte mają zostać zapisane");
  });

  it("ucięcie przed pierwszym wpisem unieważnia całą paczkę", () => {
    assert.equal(mapBatch([], [], 4, true).unsafe.size, 4);
  });
});

describe("nagłówki paczki", () => {
  it("numeruje od zera i rozdziela bloki", () => {
    assert.equal(withHeaders(["aaa", "bbb"]), "BLOK 0:\naaa\n\nBLOK 1:\nbbb");
  });
});

describe("dzielenie na paczki", () => {
  const block = (chars: number, hash: string) => ({ hash, text: "x".repeat(chars), chars });

  it("mieści całą stronę w jednej paczce — to jest cała oszczędność zasiewu", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => block(600, `h${i}`));
    assert.equal(chunk(blocks).length, 1);
  });

  it("tnie dopiero po przekroczeniu limitu wejścia", () => {
    const blocks = Array.from({ length: 5 }, (_, i) => block(15_000, `h${i}`));
    const out = chunk(blocks);
    assert.ok(out.length > 1, "75k znaków nie ma prawa jechać jednym zapytaniem");
    for (const c of out) {
      assert.ok(c.length >= 1);
      assert.ok(c.reduce((n, b) => n + b.chars, 0) <= 40_000 || c.length === 1);
    }
    assert.equal(out.flat().length, blocks.length, "żaden blok nie może zginąć przy dzieleniu");
  });

  it("blok większy niż limit jedzie sam, zamiast zniknąć", () => {
    assert.deepEqual(chunk([block(90_000, "big")]).map((c) => c.length), [1]);
  });
});

describe("schemat blokowy", () => {
  it("to schemat wydarzenia plus numer bloku", () => {
    const props = Object.keys(BlockEventSchema.properties);
    const base = Object.keys(EventSchema.properties);
    assert.deepEqual(props, [...base, "block"], "kształt wydarzenia rozjechał się z bazowym");
  });

  /**
   * Powód, dla którego `extractBatch` zdejmuje `block` PRZED walidacją. Schemat wydarzenia
   * jest zamknięty na dodatkowe pola, więc wpis z numerem bloku go nie przechodzi — a że
   * `keepValid` odrzuca po cichu (do licznika), paczka gubiłaby wszystkie wydarzenia naraz
   * i wyglądałoby to na „strona nic nie ma".
   */
  it("wpis z numerem bloku NIE przechodzi walidacji wydarzenia", () => {
    const base = { title: "Koncert", date_start: "2026-09-01" };
    assert.equal(Value.Check(EventSchema, fillMissing(EventSchema, base)), true);
    assert.equal(Value.Check(EventSchema, fillMissing(EventSchema, { ...base, block: 2 })), false);
  });
});
