/**
 * Odzysk z uszkodzonej odpowiedzi modelu.
 *
 * Test istnieje, bo koszt regresji jest asymetryczny: przy ucięciu na `max_tokens` zwykły
 * `JSON.parse` kasuje kilkadziesiąt POPRAWNYCH propozycji razem z jedną niedokończoną,
 * po opłaconym wywołaniu (Poznań 2026-08-01: $0.093 za zero źródeł).
 *
 * Druga grupa testów pilnuje resynchronizacji, czyli awarii z Lubonia (2026-08-02), która
 * jest gorsza od ucięcia: zepsuty literał NIE siedzi na końcu, tylko w środku tablicy,
 * i zabiera ze sobą wszystko, co po nim. Bez resyncu jeden nadmiarowy `"` kosztował trzy
 * ostatnie propozycje — akurat wszystkie grupy FB z tego przebiegu.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { salvageArray } from "../src/shared/json-salvage.js";

const src = (id: string, extra = ""): string =>
  `{"id":"${id}","name":"Dom Kultury ${id}","url":"https://${id}.pl"${extra}}`;

describe("salvageArray", () => {
  it("odzyskuje kompletne rekordy z tablicy uciętej w środku obiektu", () => {
    const cut = `{"sources":[${src("a")},${src("b")},{"id":"c","name":"Nie`;
    const out = salvageArray(cut, "sources") as Array<{ id: string }>;
    assert.deepEqual(out.map((s) => s.id), ["a", "b"]);
  });

  it("czyta kompletny dokument tak samo jak JSON.parse", () => {
    const whole = `{"sources":[${src("a")},${src("b")}]}`;
    assert.deepEqual(
      salvageArray(whole, "sources"),
      (JSON.parse(whole) as { sources: unknown[] }).sources,
    );
  });

  it("nie gubi obiektów zagnieżdżonych ani nawiasów w tekście", () => {
    // klamra w wartości tekstowej i zagnieżdżony obiekt to jedyne dwa sposoby, żeby
    // naiwne liczenie nawiasów rozjechało się o jeden i zwróciło śmieci
    const tricky = `{"sources":[${src("a", ',"why":"gmina {Poznań} — } w tekście","meta":{"n":1}')},${src("b")}]}`;
    const out = salvageArray(tricky, "sources") as Array<{ id: string; why?: string }>;
    assert.deepEqual(out.map((s) => s.id), ["a", "b"]);
    assert.equal(out[0]?.why, "gmina {Poznań} — } w tekście");
  });

  it("radzi sobie z ucięciem w środku literału tekstowego", () => {
    const cut = `{"sources":[${src("a")},{"id":"b","why":"ucięte w pół zda`;
    assert.deepEqual((salvageArray(cut, "sources") as Array<{ id: string }>).map((s) => s.id), ["a"]);
  });

  it("zwraca pustą listę, gdy nie ma czego odzyskać", () => {
    assert.deepEqual(salvageArray("", "sources"), []);
    assert.deepEqual(salvageArray("zupełnie nie JSON", "sources"), []);
    assert.deepEqual(salvageArray('{"sources":[{"id":"a"', "sources"), []);
    assert.deepEqual(salvageArray('{"sources":[]}', "sources"), []);
  });

  it("zatrzymuje się na końcu tablicy i nie wchodzi w dalsze pola", () => {
    const doc = `{"sources":[${src("a")}],"debug":{"id":"NIE-TO"}}`;
    assert.deepEqual((salvageArray(doc, "sources") as Array<{ id: string }>).map((s) => s.id), ["a"]);
  });
});

/**
 * Odpowiedź sformatowana tak, jak formatują ją modele: jeden rekord na kilka wierszy,
 * wcięcie dwoma spacjami. Wcięcie NIE jest tu kosmetyką — `{` na początku wiersza jest
 * jedyną kotwicą, po której skaner potrafi wrócić do siebie.
 */
const pretty = (whys: string[]): string => {
  const record = (why: string, i: number) =>
    `    {\n      "id": "s${i}",\n      "url": "https://s${i}.pl",\n      "why": "${why}"\n    }`;
  return `{\n  "sources": [\n${whys.map(record).join(",\n")}\n  ]\n}`;
};

const ids = (out: unknown[]): string[] => (out as Array<{ id: string }>).map((s) => s.id);

describe("salvageArray — resynchronizacja po zepsutym rekordzie", () => {
  /**
   * Dokładny kształt awarii z Lubonia: model otworzył cytat polskim „, zamknął ASCII-owym ",
   * czym urwał literał w połowie wartości. Od tego znaku parzystość cudzysłowów jest odwrócona
   * do KOŃCA dokumentu, więc bez resyncu nie domyka się już ani jeden kolejny obiekt.
   */
  it("gubi tylko rekord z niezescapowanym cudzysłowem, nie całą resztę", () => {
    const doc = pretty([
      "kalendarz imprez w opisie wyniku",
      'grupa o nazwie „Wydarzenia w Luboniu" – mieszkańcy wrzucają plakaty',
      "fanpage biblioteki zaprasza na warsztaty",
      "kalendarium OSiR z godzinami",
    ]);
    assert.deepEqual(ids(salvageArray(doc, "sources")), ["s0", "s2", "s3"]);
  });

  it("wraca do siebie także wtedy, gdy zepsuty rekord ma zbilansowane klamry", () => {
    // przecinek przed `}` — obiekt domyka się poprawnie, ale JSON.parse go odrzuca
    const doc = `{\n  "sources": [\n    {"id": "a"},\n    {"id": "b",},\n    {"id": "c"}\n  ]\n}`;
    assert.deepEqual(ids(salvageArray(doc, "sources")), ["a", "c"]);
  });

  it("odzyskuje kilka rekordów po kilku niezależnych uszkodzeniach", () => {
    const doc = pretty(["ok jeden", 'zepsuty „x"', "ok dwa", 'znów zepsuty „y"', "ok trzy"]);
    assert.deepEqual(ids(salvageArray(doc, "sources")), ["s0", "s2", "s4"]);
  });

  it("nie przeskakuje rekordów, gdy nic się nie zepsuło", () => {
    const doc = pretty(["a", "b", "c"]);
    assert.deepEqual(ids(salvageArray(doc, "sources")), ["s0", "s1", "s2"]);
  });

  it("dalej zatrzymuje się na `]`, mimo że po nim są kotwice", () => {
    // obiekt pod „debug" stoi na początku wiersza, czyli wygląda jak kotwica — a mimo to
    // jest już poza tablicą i nie wolno go wciągnąć
    const doc = `{\n  "sources": [\n    {"id": "a"}\n  ],\n  "debug":\n    {"id": "NIE-TO"}\n}`;
    assert.deepEqual(ids(salvageArray(doc, "sources")), ["a"]);
  });

  it("nie zapętla się na dokumencie złożonym z samych kotwic", () => {
    const doc = `{\n  "sources": [\n    {\n    {\n    {\n`;
    assert.deepEqual(salvageArray(doc, "sources"), []);
  });
});
