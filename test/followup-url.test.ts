/**
 * Adres followupa konfrontowany z inwentarzem strony.
 *
 * PRZYPADEK Z ŻYWYCH DANYCH (przebieg 2026-08-12, źródło `mdk2-poznan`): strona linkuje
 * `/images/mdk2/rekrutacja_2026_2007/…`, a model oddał `https://mdk2.poznan.pl/images/mdk/…`
 * — sklejając domenę ze ścieżką, zużył „2" na host. Trzy PDF-y, trzy razy ta sama zguba,
 * 404 w siedmiu kolejnych przebiegach, bo martwy adres wsiąkł w `state.followupsBySource`,
 * a 404 nie zmienia hasha strony.
 *
 * Fixtura to PRAWDZIWA strona pobrana 2026-08-19 i taka ma zostać — cały sens tej reguły
 * polega na tym, co serwis NAPRAWDĘ ma w `href`, więc wymyślony HTML dowodziłby tu zera.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { groundFollowups } from "../src/pipeline/extract/followup-url.js";
import { auditTrails, beginAuditRun, beginAuditSource } from "../src/shared/audit.js";

const HTML = readFileSync(
  fileURLToPath(new URL("fixtures/mdk2-poznan-aktualnosci-2026-08-19.html", import.meta.url)), "utf8");
const PAGE = "https://mdk2.poznan.pl/aktualnosci.html";
const OFERTA = "https://mdk2.poznan.pl/images/mdk2/rekrutacja_2026_2007/Oferta%20do%20rekrutacji%20otwartej.pdf";
/** dokładnie to, co model zapisał w `state.json` 2026-08-12 — bez „2" w ścieżce */
const OFERTA_MODEL = "https://mdk2.poznan.pl/images/mdk/rekrutacja_2026_2007/Oferta%20do%20rekrutacji%20otwartej.pdf";

const steps = (): string[] => auditTrails().flatMap((t) => t.steps.map((s) => s.step));

beforeEach(() => { beginAuditRun(); beginAuditSource("mdk2-poznan"); });

describe("followup: adres ze strony, nie z pamięci modelu", () => {
  it("adres względny rozwija się względem strony, bez udziału modelu", () => {
    const got = groundFollowups(["/images/mdk2/rekrutacja_2026_2007/Oferta%20do%20rekrutacji%20otwartej.pdf"],
      PAGE, HTML);
    assert.deepEqual(got, [OFERTA]);
    assert.deepEqual(steps(), []); // trafienie wprost nie jest decyzją, nie ma o czym pisać
  });

  it("adres sklejony przez model wraca do tego, który stoi na stronie", () => {
    assert.deepEqual(groundFollowups([OFERTA_MODEL], PAGE, HTML), [OFERTA]);
    assert.deepEqual(steps(), ["followup.url"]);
  });

  it("adres z tego serwisu, którego na stronie nie ma, odpada przed pobraniem", () => {
    assert.deepEqual(groundFollowups(["https://mdk2.poznan.pl/program-lato-2026.pdf"], PAGE, HTML), []);
    assert.deepEqual(steps(), ["followup.url"]);
  });

  it("obca domena przechodzi — inwentarz strony nie jest dla niej wyrocznią", () => {
    const cdn = "https://scontent.xx.fbcdn.net/plakat.jpg";
    assert.deepEqual(groundFollowups([cdn], PAGE, HTML), [cdn]);
    assert.deepEqual(steps(), []);
  });

  it("bez HTML-a (PDF, feed, posty grupy) adresy tylko się rozwijają", () => {
    assert.deepEqual(groundFollowups(["/a.pdf", OFERTA_MODEL], PAGE, undefined),
      ["https://mdk2.poznan.pl/a.pdf", OFERTA_MODEL]);
    assert.deepEqual(steps(), []);
  });

  it("jest idempotentna — druga runda nie ma czego naprawiać ani co dopisać do śladu", () => {
    const once = groundFollowups([OFERTA_MODEL], PAGE, HTML);
    beginAuditRun();
    beginAuditSource("mdk2-poznan");
    assert.deepEqual(groundFollowups(once, PAGE, HTML), once);
    assert.deepEqual(steps(), []);
  });

  it("dwa zapisy tego samego adresu schodzą się w jedno pobranie", () => {
    const got = groundFollowups([OFERTA, OFERTA_MODEL], PAGE, HTML);
    assert.deepEqual(got, [OFERTA]);
  });

  it("nie-adres odpada z własnym śladem, zamiast lecieć do pobrania", () => {
    assert.deepEqual(groundFollowups(["program PDF na stronie"], PAGE, HTML), []);
    assert.deepEqual(steps(), ["followup.url"]);
  });
});
