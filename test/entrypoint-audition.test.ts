/**
 * Przesłuchanie entrypointu przy discovery: jedna ekstrakcja zamiast trzydziestu.
 *
 * To jedyne miejsce w etapie 1, które celowo wydaje pieniądze na model poza profilowaniem,
 * więc testy pilnują przede wszystkim granic: kogo wolno przesłuchać (tylko `unendorsed`)
 * i za co NIE wolno odrzucić (awaria sieci).
 *
 * Rachunek, dla którego to istnieje: adres bez przesłuchania trafia do rejestru i `daily`
 * posyła go do modelu codziennie — ~30 ekstrakcji miesięcznie za stronę, o której już
 * wiadomo, że nic nie da.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  type Audition, type EntryProbe, auditionEntrypoints, auditionVerdict,
} from "../src/pipeline/discover/entrypoint-audition.js";
import type { EntryPoint } from "../src/types/index.js";

const ep = (over: Partial<EntryPoint> = {}): EntryPoint => ({
  url: "https://gok.test/wydarzenia", kind: "listing", confidence: 0.6, via: "heuristic", ...over,
});

/** Sonda-atrapa: zapisuje, o co ją pytano, i oddaje z góry ustalony wynik. */
function fakeProbe(found: Audition): EntryProbe & { urls: string[] } {
  const urls: string[] = [];
  const probe = (url: string): Promise<Audition> => {
    urls.push(url);
    return Promise.resolve(found);
  };
  return Object.assign(probe, { urls });
}

describe("auditionVerdict — reguła", () => {
  it("wydarzenia w próbnej ekstrakcji zatrzymują adres", () => {
    assert.equal(auditionVerdict({ ok: true, events: 3 }).keep, true);
  });

  it("zero wydarzeń odrzuca", () => {
    const v = auditionVerdict({ ok: true, events: 0 });
    assert.equal(v.keep, false);
    assert.match(v.why, /ani jednego wydarzenia/);
  });

  it("awaria pobrania NIE odrzuca", () => {
    // sonda potrafi przegrać tam, gdzie wygrywa pełny potok daily — kasowanie adresu
    // za błąd sieci to ta sama pomyłka, którą po stronie weryfikacji zamyka weto plonu
    const v = auditionVerdict({ ok: false, events: 0, err: "ENOTFOUND" });
    assert.equal(v.keep, true);
    assert.match(v.why, /nie odrzucamy za awarię sieci/);
  });
});

describe("auditionEntrypoints — kogo w ogóle przesłuchujemy", () => {
  it("adres wskazany przez model przechodzi BEZ ekstrakcji", async () => {
    const probe = fakeProbe({ ok: true, events: 0 });
    const out = await auditionEntrypoints([ep({ via: "llm", confidence: 0.9 })], probe);

    assert.deepEqual(probe.urls, [], "potwierdzony adres nie płaci drugi raz za to samo");
    assert.equal(out.entrypoints.length, 1);
  });

  it("adres niepotwierdzony przez model jest przesłuchiwany", async () => {
    const probe = fakeProbe({ ok: true, events: 3 });
    const out = await auditionEntrypoints([ep({ unendorsed: true })], probe);

    assert.deepEqual(probe.urls, ["https://gok.test/wydarzenia"]);
    assert.equal(out.entrypoints.length, 1);
  });

  it("jałowy adres nie wchodzi do rejestru", async () => {
    const out = await auditionEntrypoints([ep({ unendorsed: true })], fakeProbe({ ok: true, events: 0 }));

    assert.equal(out.entrypoints.length, 0);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0]?.url, "https://gok.test/wydarzenia");
  });

  it("paginację podstawiamy przed pobraniem", async () => {
    const probe = fakeProbe({ ok: true, events: 1 });
    await auditionEntrypoints([ep({ url: "https://gok.test/akt/page/{page}", unendorsed: true })], probe);

    assert.deepEqual(probe.urls, ["https://gok.test/akt/page/1"]);
  });
});
