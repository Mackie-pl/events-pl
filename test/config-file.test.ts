/**
 * `config.json` — progi wersjonowane w repo.
 *
 * Dwie rzeczy są tu warte testu, bo pomyłka w każdej z nich jest cicha:
 *   - do pliku NIE MOŻE wpaść nic poza progami. Repo jest publiczne, a plik wygląda jak
 *     zwykły worek na konfigurację, więc jedyne, co dzieli sekret od commita, to klasa
 *     parametru — i to ona jest tu sprawdzana z obu stron (co generator wypisuje ORAZ czego
 *     odczyt nie tknie, gdyby ktoś dopisał to ręcznie),
 *   - pierwszeństwo env → plik → domyślna. Odwrotna kolejność znaczyłaby, że commit
 *     w repo cicho wygrywa z sekretem ustawionym na czas awarii.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import {
  ALL_PARAMS, P, configFile, configSnapshot, freshConfigFile, parseConfig,
  renderConfigFile, resetConfigFile,
} from "../src/config/index.js";
import { CONFIG_PATH } from "../src/shared/paths.js";

const lf = (s: string): string => s.replaceAll("\r\n", "\n");

const tuning = ALL_PARAMS.filter((p) => p.cls === "tuning");
// wyciągnięte z testów, żeby nie zagnieżdżać kolejnego callbacka pod helperami
const TUNING_NAMES = tuning.map((p) => p.name);

/** Klucze progów z pliku: `_` to notka dla czytającego, nie parametr. */
const fileKeys = (o: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(o).filter((k) => k !== "_");

/**
 * Cała reszta suity jedzie z `CONFIG_FILE=0` (patrz test/config-off.ts), więc plik trzeba tu
 * włączyć z powrotem — to jedyne miejsce, które sprawdza właśnie jego działanie.
 */
const withFileLayer = (fn: () => void): void => {
  const before = process.env["CONFIG_FILE"];
  try {
    process.env["CONFIG_FILE"] = "1";
    resetConfigFile();
    fn();
  } finally {
    if (before === undefined) delete process.env["CONFIG_FILE"];
    else process.env["CONFIG_FILE"] = before;
    resetConfigFile();
  }
};

/** Warstwa pliku WŁĄCZONA i jedna zmienna środowiskowa podmieniona — bez zagnieżdżania. */
const withFileAndEnv = (name: string, value: string | undefined, fn: () => void): void => {
  withFileLayer(() => { withEnv(name, value, fn); });
};

/** Podmiana zmiennej środowiskowej z posprzątaniem — env wygrywa, więc trzeba go cofać. */
const withEnv = (name: string, value: string | undefined, fn: () => void): void => {
  const before = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
};

afterEach(() => {
  resetConfigFile();
});

describe("config.json — zawartość", () => {
  it("jest tym, co produkuje generator (inaczej: npm run config:docs)", () => {
    withFileLayer(() => {
      assert.equal(lf(readFileSync(CONFIG_PATH, "utf-8")), lf(freshConfigFile()));
    });
  });

  it("wymienia dokładnie progi — ani jednego sekretu, ani jednego adresu", () => {
    withFileLayer(() => {
      assert.deepEqual(fileKeys(configFile()), TUNING_NAMES);
    });
  });

  it("generator nie nadpisuje wartości, tylko pilnuje kluczy", () => {
    // wartość zmieniona ręcznie ma przeżyć przebudowę — to cały sens tego pliku
    const rendered = renderConfigFile({ FB_MUTE_DAYS: 45, STARY_PRÓG: 1 });
    const out = parseConfig(rendered, "test");
    assert.equal(out["FB_MUTE_DAYS"], 45, "ręczna wartość przepadła");
    assert.notEqual(out["FB_MUTE_DAYS"], P.FB_MUTE_DAYS.defaultJson, "test nic nie sprawdza");
    assert.ok(!("STARY_PRÓG" in out), "klucz spoza rejestru powinien zniknąć");
    // progi, których w podanym pliku nie było, wchodzą z wartością domyślną
    assert.equal(out["FB_YIELD_MIN_RUNS"], P.FB_YIELD_MIN_RUNS.defaultJson);
  });

  it("odrzuca kształty, których nie umie zinterpretować", () => {
    assert.throws(() => parseConfig("[1,2]", "x"), /oczekiwano obiektu/);
    assert.throws(() => parseConfig('{"A":{"b":1}}', "x"), /liczbą, tekstem albo/);
    assert.throws(() => parseConfig("{nie-json", "x"));
  });
});

describe("config.json — pierwszeństwo", () => {
  it("env wygrywa z plikiem", () => {
    withEnv("FB_MUTE_DAYS", "7", () => {
      assert.equal(P.FB_MUTE_DAYS.get(), 7);
      assert.equal(P.FB_MUTE_DAYS.source(), "env");
    });
  });

  it("bez env obowiązuje plik, a jego wartość jest oznaczona jako pochodząca z pliku", () => {
    withFileAndEnv("FB_MUTE_DAYS", undefined, () => {
      assert.equal(P.FB_MUTE_DAYS.get(), configFile()["FB_MUTE_DAYS"]);
      assert.equal(P.FB_MUTE_DAYS.source(), "config.json");
    });
  });

  it("CONFIG_FILE=0 zdejmuje całą warstwę pliku — env nie umie cofnąć progu do nieustawionego", () => {
    withEnv("FB_MUTE_DAYS", undefined, () => {
      // reszta suity jedzie właśnie tak; gdyby to przestało działać, zmiana progu w repo
      // zapalałaby na czerwono testy, które o tym progu nic nie wiedzą
      assert.equal(P.FB_MUTE_DAYS.source(), "domyślna");
      assert.equal(P.FB_MUTE_DAYS.get(), P.FB_MUTE_DAYS.defaultJson);
    });
  });

  it("wartość z pliku przechodzi tę samą walidację, co ze środowiska", () => {
    // -5 z env wraca do domyślnej; -5 z pliku musi zachować się TAK SAMO, inaczej mamy
    // dwie ścieżki wejścia z dwoma zestawami reguł
    withEnv("FB_MUTE_DAYS", "-5", () => {
      assert.equal(P.FB_MUTE_DAYS.get(), P.FB_MUTE_DAYS.defaultJson);
    });
  });

  it("parametry spoza klasy `tuning` nie czytają pliku w ogóle", () => {
    // gdyby ktoś wpisał klucz do config.json ręcznie, ma to zostać bez efektu
    withFileAndEnv("MODEL_EXTRACT", undefined, () => {
      assert.equal(P.MODEL_EXTRACT.source(), "domyślna");
      assert.notEqual(P.OPENROUTER_API_KEY.source(), "config.json");
    });
  });
});

describe("migawka progów w raporcie", () => {
  it("obejmuje wszystkie progi i nic poza nimi", () => {
    assert.deepEqual(Object.keys(configSnapshot().values), TUNING_NAMES);
  });

  it("nazywa progi, które przyszły ze środowiska — bo tych nie widać w historii repo", () => {
    withEnv("FB_MUTE_DAYS", "7", () => {
      const snap = configSnapshot();
      assert.deepEqual(snap.fromEnv, ["FB_MUTE_DAYS"]);
      assert.equal(snap.values["FB_MUTE_DAYS"], 7);
    });
  });

  it("bez nadpisań ze środowiska nie dokłada pustego pola do raportu", () => {
    const before = tuning.map((p) => [p.name, process.env[p.name]] as const);
    try {
      for (const p of tuning) delete process.env[p.name];
      assert.equal(configSnapshot().fromEnv, undefined);
    } finally {
      for (const [name, v] of before) if (v !== undefined) process.env[name] = v;
    }
  });
});
