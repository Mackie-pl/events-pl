/**
 * Dobór fanpage'ów do sondy decyduje o WYDANIU PIENIĘDZY i — co gorsza — o tym, czego
 * nigdy nie zmierzymy. Werdykt „covered" zdejmuje źródło z listy po cichu, więc testy
 * pilnują przede wszystkim tego kierunku: co wolno uznać za zbędne, a czego nie.
 *
 * Przypadki są WPROST z rejestru (2026-08-16), bo to na nich heurystyka się myliła:
 * `cik-poznan-fb` parowało się z `ck-zamek` po „centrum kultury", a fanpage biblioteki
 * w Puszczykowie — z kalendarzem miasta, tylko dlatego, że miasto miało wyższy plon.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { classifyFbPages, stems, toProbe } from "../src/reporting/fb-page-candidates.js";
import type { SourceYield } from "../src/reporting/source-yield.js";
import type { Source } from "../src/types/index.js";

const src = (id: string, name: string, town: string, fetch: Source["fetch"]): Source =>
  ({ id, name, town, url: `https://example.test/${id}`, type: "venue", fetch, verified: false });

const row = (id: string, distinct: number, status = "ok"): SourceYield =>
  ({ id, distinct, status } as SourceYield);

describe("stems", () => {
  it("tnie polską odmianę do wspólnego rdzenia", () => {
    const a = stems("Ośrodek Kultury w Luboniu", "Luboń");
    assert.ok(a.has("osrod"));
    assert.ok(a.has("kultu"));
  });

  it("wyrzuca token gminy — inaczej w Luboniu wszystko pasuje do wszystkiego", () => {
    assert.equal(stems("Miasto Luboń", "Luboń").has("lubon"), false);
  });

  it("zostawia „gmina” — to jedyny token, jaki ma fanpage urzędu", () => {
    assert.ok(stems("Gmina Komorniki", "Komorniki").has("gmina"));
  });
});

describe("classifyFbPages", () => {
  it("uznaje fanpage za zbędny, gdy strona instytucji ma unikalny skrót i realny plon", () => {
    const sources = [
      src("fb-gok-komorniki", "Gminny Ośrodek Kultury w Komornikach", "Komorniki", "fb"),
      src("gok-komorniki-kalendarz", "GOK Komorniki - Kalendarz Wydarzeń", "Komorniki", "plain"),
    ];
    const [c] = classifyFbPages(sources, [row("gok-komorniki-kalendarz", 10)]);
    assert.equal(c?.bucket, "covered");
    assert.equal(c?.peer?.id, "gok-komorniki-kalendarz");
  });

  it("NIE uznaje za zbędny na samym „centrum kultury” — w Poznaniu pasuje do pięciu instytucji", () => {
    const sources = [
      src("cik-poznan-fb", "Centrum Informacji Kulturalnej Poznań", "Poznań", "fb"),
      src("ck-zamek", "Centrum Kultury Zamek w Poznaniu", "Poznań", "plain"),
      src("jck-poznan", "Jeżyckie Centrum Kultury", "Poznań", "plain"),
    ];
    const [c] = classifyFbPages(sources, [row("ck-zamek", 69), row("jck-poznan", 0)]);
    assert.equal(c?.bucket, "no-site");
  });

  it("przy remisie wybiera stronę o NIŻSZYM plonie — remis znaczy „nie wiadomo”, więc mierzymy", () => {
    const sources = [
      src("biblioteka-puszczykowo-fb", "Biblioteka Miejska Centrum Animacji Kultury", "Puszczykowo", "fb"),
      src("biblioteka-puszczykowo-sowa", "Biblioteka Miejska im. Musierowicz CAK", "Puszczykowo", "plain"),
      src("puszczykowo-pl-kultura", "Miasto Puszczykowo – Wydarzenia kulturalne", "Puszczykowo", "plain"),
    ];
    const [c] = classifyFbPages(sources, [
      row("biblioteka-puszczykowo-sowa", 0, "skipped-dead"),
      row("puszczykowo-pl-kultura", 22),
    ]);
    assert.equal(c?.peer?.id, "biblioteka-puszczykowo-sowa");
    assert.equal(c?.bucket, "stale-site");
  });

  it("brak jakiejkolwiek strony instytucji → fanpage jest jej jedynym kanałem", () => {
    const sources = [
      src("losir-lubon-fb", "LOSiR Luboń", "Luboń", "fb"),
      src("biblioteka-lubon-www", "Biblioteka Miejska w Luboniu", "Luboń", "plain"),
    ];
    const [c] = classifyFbPages(sources, [row("biblioteka-lubon-www", 16)]);
    assert.equal(c?.bucket, "no-site");
    assert.equal(c?.peer, undefined);
  });

  it("strona istnieje, ale jest archiwum → do sondy, bo nie wiadomo, kto milczy", () => {
    const sources = [
      src("fb-gosir-komorniki", "GOSiR Komorniki", "Komorniki", "fb"),
      src("gosir-komorniki-wydarzenia", "GOSiR Komorniki - Aktualności", "Komorniki", "plain"),
    ];
    const all = classifyFbPages(sources, [row("gosir-komorniki-wydarzenia", 0, "empty")]);
    assert.equal(all[0]?.bucket, "stale-site");
    assert.equal(toProbe(all).length, 1);
  });

  it("nie parują się instytucje z różnych gmin", () => {
    const sources = [
      src("fb-biblioteka-mosina", "Biblioteka Publiczna w Mosinie", "Mosina", "fb"),
      src("biblioteka-lubon-www", "Biblioteka Miejska w Luboniu", "Luboń", "plain"),
    ];
    const [c] = classifyFbPages(sources, [row("biblioteka-lubon-www", 16)]);
    assert.equal(c?.bucket, "no-site");
  });

  it("do sondy idzie wszystko poza „covered”", () => {
    const sources = [
      src("a-fb", "Dom Kultury Alfa", "X", "fb"),
      src("a-www", "Dom Kultury Alfa - kalendarz", "X", "plain"),
      src("b-fb", "Hala Beta", "X", "fb"),
    ];
    const all = classifyFbPages(sources, [row("a-www", 12)]);
    assert.deepEqual(toProbe(all).map((c) => c.id), ["b-fb"]);
  });
});
