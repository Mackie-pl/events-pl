/**
 * Sonda w całości wymaga sieci i płatnego modelu, więc testujemy jej jedyny kawałek
 * z darmową wyrocznią: czyszczenie cache pod `--force`.
 *
 * To nie jest test kosmetyczny. Jeśli `forgetSource` przeoczy choć jedno miejsce, sonda
 * z `--force` odpowie „bez zmian, wynik z cache" — czyli dokładnie to, przed czym `--force`
 * ma chronić — a użytkownik zobaczy wczorajszy wynik w przekonaniu, że sprawdził dziś.
 * Drugi kierunek jest równie ważny: skasowanie za dużo (cudze źródło, cache geokodera)
 * zamienia sondę w kasownik stanu, który przy zapisie kosztowałby pieniądze i limity.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { archiveEnabled, suppressArchive } from "../src/adapters/supabase-archive.js";
import { forgetSource } from "../src/pipeline/extract/probe-source.js";
import type { CachedExtraction, PipelineState } from "../src/types/index.js";

const extraction = (hash: string): CachedExtraction => ({ hash, events: [], at: "2026-07-27T04:00:00.000Z" });

const state = (): PipelineState => ({
  hashes: { zamek: "h1", kultura: "h2" },
  geo: { "Rynek|Poznań": { lat: 52.4, lon: 16.9 } },
  extractions: {
    zamek: { ...extraction("h1"), etag: "W/\"abc\"", lastModified: "Mon, 27 Jul 2026 04:00:00 GMT" },
    kultura: extraction("h2"),
    "https://zamek.pl/program.pdf": extraction("h3"),
    "https://kultura.pl/plakat.jpg": extraction("h4"),
  },
  followupsBySource: {
    zamek: ["https://zamek.pl/program.pdf"],
    kultura: ["https://kultura.pl/plakat.jpg"],
  },
});

describe("forgetSource (--force)", () => {
  it("kasuje ekstrakcję źródła razem z walidatorami HTTP", () => {
    const s = state();
    forgetSource(s, "zamek");
    // walidatory zniknęły razem z wpisem — bez If-None-Match serwer nie ma jak odpowiedzieć 304
    assert.equal(s.extractions?.["zamek"], undefined);
    assert.equal(s.hashes["zamek"], undefined);
  });

  it("kasuje też followupy źródła — plakat z cache dałby wczorajszy wynik", () => {
    const s = state();
    forgetSource(s, "zamek");
    assert.equal(s.extractions?.["https://zamek.pl/program.pdf"], undefined);
  });

  it("nie rusza innych źródeł ani ich followupów", () => {
    const s = state();
    forgetSource(s, "zamek");
    assert.equal(s.extractions?.["kultura"]?.hash, "h2");
    assert.equal(s.extractions?.["https://kultura.pl/plakat.jpg"]?.hash, "h4");
    assert.equal(s.hashes["kultura"], "h2");
  });

  it("zostawia cache geokodera — sonda sprawdza ekstrakcję, nie Nominatim (limit 1/s)", () => {
    const s = state();
    forgetSource(s, "zamek");
    assert.deepEqual(s.geo, { "Rynek|Poznań": { lat: 52.4, lon: 16.9 } });
  });

  it("na nieznanym źródle i pustym stanie nie wybucha", () => {
    const empty: PipelineState = { hashes: {}, geo: {} };
    forgetSource(empty, "nie-ma-takiego");
    assert.deepEqual(empty, { hashes: {}, geo: {} });
  });
});

/**
 * Sonda odsyła prompt i odpowiedź modelu wprost do panelu, więc na czas jej trwania archiwum
 * jest wyłączane. Gdyby wyłącznik przestał działać, nikt by tego nie zauważył: pipeline działa
 * dalej, a do prywatnego bucketa po cichu leci obiekt na każdy klik w panelu — nie do odróżnienia
 * od przebiegu crona, akurat w archiwum, którego zadaniem jest tłumaczenie tych przebiegów.
 */
describe("suppressArchive (sonda)", () => {
  afterEach(() => {
    suppressArchive(false);
    delete process.env["SUPABASE_URL"];
    delete process.env["SUPABASE_SECRET_KEY"];
  });

  it("wyłącza archiwum mimo poprawnej konfiguracji i przywraca je po zakończeniu", () => {
    process.env["SUPABASE_URL"] = "https://przyklad.supabase.co";
    process.env["SUPABASE_SECRET_KEY"] = "sb_secret_test";
    assert.equal(archiveEnabled(), true);

    suppressArchive(true);
    assert.equal(archiveEnabled(), false);

    // przywrócenie jest równie ważne: sonda w tym samym procesie co most nie może
    // zostawić archiwum wyłączonego dla niczego, co przyjdzie po niej
    suppressArchive(false);
    assert.equal(archiveEnabled(), true);
  });
});
