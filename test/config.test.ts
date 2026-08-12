/**
 * Rejestr parametrów pilnowany z dwóch stron.
 *
 * `.env.example` jest WYNIKIEM, nie źródłem, a plik generowany nikomu nie służy, jeśli ktoś
 * dopisze parametr i zapomni go przebudować — wtedy dokumentacja kłamie, a to gorzej niż jej
 * brak. Drugi test broni samej zasady „jedno miejsce": moment, w którym jakiś moduł znowu
 * sięgnie po `process.env` na własną rękę, jest momentem, w którym rejestr przestaje być
 * pełną listą pokręteł.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ALL_PARAMS, GROUPS, applyReadmeConfig, renderEnvExample } from "../src/config/index.js";
import { ENV_EXAMPLE_PATH, README_PATH, ROOT } from "../src/shared/paths.js";

/** Repo bywa sklonowane z autocrlf — porównujemy treść, nie końce linii. */
const lf = (s: string): string => s.replaceAll("\r\n", "\n");

const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });

/**
 * Porównanie linia po linii, bo `assert.equal` na kilkuset liniach wypluwa oba dokumenty
 * naraz i pierwsza różnica ginie w ścianie tekstu.
 */
function assertSame(label: string, onDiskRaw: string, freshRaw: string): void {
  const onDisk = lf(onDiskRaw).split("\n");
  const fresh = lf(freshRaw).split("\n");
  const i = onDisk.findIndex((line, n) => line !== fresh[n]);
  if (i !== -1) {
    assert.fail(
      `${label} rozjechał się z src/config/params.ts w linii ${i + 1} — `
      + `przebuduj przez \`npm run config:docs\`\n  jest:     ${onDisk[i] ?? "(koniec pliku)"}`
      + `\n  powinno:  ${fresh[i] ?? "(koniec pliku)"}`,
    );
  }
  assert.equal(onDisk.length, fresh.length, `${label} ma inną liczbę linii niż rejestr`);
}

describe(".env.example", () => {
  it("jest tym, co produkuje rejestr (inaczej: npm run config:docs)", () => {
    assertSame(".env.example", readFileSync(ENV_EXAMPLE_PATH, "utf-8"), renderEnvExample());
  });

  it("nie wypisuje zmiennych, których i tak nie ustawia się ręcznie", () => {
    const rendered = renderEnvExample();
    for (const p of ALL_PARAMS.filter((x) => x.cls === "ambient")) {
      assert.ok(!rendered.includes(p.name), `${p.name} daje środowisko, nie .env`);
    }
  });
});

describe("README", () => {
  it("tabela parametrów jest tym, co produkuje rejestr (inaczej: npm run config:docs)", () => {
    const onDisk = readFileSync(README_PATH, "utf-8");
    // applyReadmeConfig rzuca, gdy ktoś skasował znaczniki — czyli i to jest tu sprawdzone
    assertSame("README.md", onDisk, applyReadmeConfig(onDisk));
  });

  it("wymienia każdy parametr, także ten od środowiska", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    for (const p of ALL_PARAMS) {
      assert.ok(readme.includes(`\`${p.name}\``), `${p.name}: brak w tabeli README`);
    }
  });
});

describe("rejestr", () => {
  it("każdy parametr siedzi w zadeklarowanej grupie", () => {
    const known = new Set<string>(GROUPS.map((g) => g.id));
    for (const p of ALL_PARAMS) {
      assert.ok(known.has(p.group), `${p.name}: nieznana grupa "${p.group}"`);
    }
  });

  it("żaden sekret nie ma wartości domyślnej", () => {
    // `example` wolno mieć — to podpowiedź kształtu (`sk-or-...`), nie działający klucz.
    // Wartość DOMYŚLNA to co innego: znaczyłaby, że sekret siedzi w repo.
    for (const p of ALL_PARAMS.filter((x) => x.cls === "secret")) {
      assert.equal(p.defaultText, "", `${p.name}: sekret z wartością domyślną`);
    }
  });

  it("czyta środowisko leniwie — podmiana process.env działa po imporcie", () => {
    const before = process.env["FB_MUTE_DAYS"];
    try {
      process.env["FB_MUTE_DAYS"] = "7";
      assert.equal(ALL_PARAMS.find((p) => p.name === "FB_MUTE_DAYS")?.get(), 7);
    } finally {
      if (before === undefined) delete process.env["FB_MUTE_DAYS"];
      else process.env["FB_MUTE_DAYS"] = before;
    }
  });

  it("pusta wartość znaczy brak, nie zero — GH Actions tak podaje nieustawiony secret", () => {
    const before = process.env["EXTRACT_MAX_TOKENS"];
    try {
      process.env["EXTRACT_MAX_TOKENS"] = "";
      assert.equal(ALL_PARAMS.find((p) => p.name === "EXTRACT_MAX_TOKENS")?.get(), 12_000);
    } finally {
      if (before === undefined) delete process.env["EXTRACT_MAX_TOKENS"];
      else process.env["EXTRACT_MAX_TOKENS"] = before;
    }
  });
});

describe("jedno miejsce odczytu", () => {
  it("poza src/config nikt nie czyta process.env", () => {
    // zapis (`process.env["X"] = …`) zostaje dozwolony: tak sondy wymuszają tryb na sobie
    const write = /process\.env\[[^\]]*\]\s*=[^=]/;

    const offenders: string[] = [];
    for (const file of tsFiles(join(ROOT, "src"))) {
      if (file.includes(join("src", "config"))) continue;
      for (const [i, line] of readFileSync(file, "utf-8").split("\n").entries()) {
        if (line.includes("process.env[") && !write.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `odczyt środowiska poza rejestrem — dopisz parametr do src/config/params.ts:\n${offenders.join("\n")}`);
  });
});
