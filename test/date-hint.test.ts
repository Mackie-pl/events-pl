/**
 * Bezpiecznik na datę wymyśloną przez model — na materiale, na którym się wysypał.
 *
 * Wszystkie cztery wydarzenia w „przypadek imprezy-poznan" to prawdziwa odpowiedź Haiku 4.5
 * z przebiegu 2026-08-12 (wywołanie 0041), a teksty postów to prawdziwa treść oddana przez
 * Bright Data. Trzy z nich model wyssał z palca — datą stał się dzień przebiegu — a czwarte
 * („już jutro") jest prawidłowe i MUSI przeżyć. Test pilnuje właśnie tej granicy: bezpiecznik
 * ma strzelać do zgadywania, nie do wydarzeń opisanych mgliście.
 *
 * Drugi ważny szczegół z tamtego przebiegu: model podpisał wszystkie cztery wpisy numerem
 * bloku 1, choć trzy stały w innych blokach. Dlatego dowód wiąże się `source_url`, nie blokiem.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hasDateHint, keepFoundedDates, postsByLink } from "../src/pipeline/extract/date-hint.js";
import { urlKey } from "../src/shared/url.js";
import type { EventItem } from "../src/types/index.js";

const base = (): EventItem =>
  ({ title: "Koncert", date_start: "2026-08-12", repeat: "", source_url: "", is_noise: false } as EventItem);

const withOver = (over: Partial<EventItem>): EventItem => ({ ...base(), ...over });

describe("hasDateHint — co uznajemy za wyznaczenie terminu", () => {
  it("łapie daty w każdym zapisie, jaki chodzi po polskich ogłoszeniach", () => {
    for (const t of ["📅 21 sierpnia 2026, godz. 19:00", "21.08", "21 / 08", "2026-08-21", "Sobota 8 Sierpnia"]) {
      assert.equal(hasDateHint(t), true, t);
    }
  });

  it("łapie terminy względne i dni tygodnia — model ma prawo je rozwiązać", () => {
    for (const t of ["już jutro na Placu Wolności", "To już dziś!", "w każdy czwartek", "w najbliższą sobotę"]) {
      assert.equal(hasDateHint(t), true, t);
    }
  });

  it("nie uznaje za termin tekstu, w którym go nie ma", () => {
    for (const t of [
      "Rezerwuj stolik na wyjątkowy Wieczór Grecki. Muzyka na żywo, pyszna kuchnia",
      "Zapraszam na reaktywację Wanna Wanna Cuban Party, 3 lata nieobecności trzeba nadrobić!",
      "Wakacyjne warsztaty taneczne od podstaw dla tych, którzy chcieliby posmakować radości",
      "godz. 19:00", // sama godzina terminu nie wyznacza
    ]) {
      assert.equal(hasDateHint(t), false, t);
    }
  });

  it("nie bierze daty z adresu — to data publikacji, nie termin", () => {
    assert.equal(hasDateHint("Zapraszamy! https://gok.pl/2026/08/13/koncert"), false);
  });

  /**
   * Ozdobne warianty znaków z Facebooka. Bez NFKC bezpiecznik kasuje wydarzenia PRAWDZIWE
   * (dwa na przegraniu dnia 2026-08-12) — model czyta te cyfry normalnie, `\d` ich nie widzi.
   */
  it("czyta daty pisane ozdobnymi znakami Unicode", () => {
    assert.equal(hasDateHint("𝟏𝟓.𝟎𝟖, 17:00 – Spacer po Trakcie"), true);
    assert.equal(hasDateHint("𝟐𝟏 𝐬𝐢𝐞𝐫𝐩𝐧𝐢𝐚 zapraszamy"), true);
  });
});

describe("postsByLink — dowód wiązany adresem postu", () => {
  const text = [
    "BLOK 0:",
    "DATA POSTU: 2026-08-11T11:35:22.000Z",
    "LINK: https://www.facebook.com/groups/imprezypoznan/posts/4087400011395070/",
    "Wakacyjne warsztaty taneczne od podstaw",
    "",
    "---",
    "",
    "DATA POSTU: 2026-08-08T11:11:40.000Z",
    "LINK: https://www.facebook.com/groups/imprezypoznan/posts/4083670411768030/",
    "Plany na dziś! Sobota 8 Sierpnia",
  ].join("\n");

  it("rozcina tekst na posty i nie miesza treści sąsiadów", () => {
    const posts = postsByLink(text);
    assert.equal(posts.size, 2);
    const first = posts.get(urlKey("https://www.facebook.com/groups/imprezypoznan/posts/4087400011395070/"))!;
    assert.match(first, /Wakacyjne warsztaty/);
    assert.doesNotMatch(first, /Sobota 8 Sierpnia/, "data sąsiada nie może usprawiedliwiać tego postu");
  });

  it("nagłówek DATA POSTU nie jest terminem — inaczej każdy post miałby datę", () => {
    const posts = postsByLink(text);
    const klucz = urlKey("https://www.facebook.com/groups/imprezypoznan/posts/4087400011395070/");
    assert.equal(hasDateHint(posts.get(klucz)!), false);
  });
});

describe("keepFoundedDates — przypadek imprezy-poznan (2026-08-12)", () => {
  const post = (id: string, body: string): string =>
    `DATA POSTU: 2026-08-11T10:00:00.000Z\nLINK: https://www.facebook.com/groups/imprezypoznan/posts/${id}/\n${body}`;

  const text = [
    post("4087400011395070", "Wakacyjne warsztaty taneczne od podstaw dla tych, którzy chcieliby posmakować radości"),
    post("4087356748066063", "Zapraszamy na salsę, już jutro na Placu Wolności!\nKlub pod Minogą"),
    post("4079667855501619", "Zapraszam na reaktywację Wanna Wanna Cuban Party, 3 lata nieobecności trzeba nadrobić!"),
    post("4077491349052603", "Rezerwuj stolik na wyjątkowy Wieczór Grecki. Muzyka na żywo, pyszna kuchnia"),
  ].join("\n\n---\n\n");

  const url = (id: string): string => `https://www.facebook.com/groups/imprezypoznan/posts/${id}/`;

  it("kasuje trzy zmyślone daty, zostawia jedną prawdziwą", () => {
    const kept = keepFoundedDates([
      withOver({ title: "Warsztaty taneczne - tańce swingowe", source_url: url("4087400011395070") }),
      withOver({ title: "Salsa na Placu Wolności", source_url: url("4087356748066063") }),
      withOver({ title: "Wanna Wanna Cuban Party", source_url: url("4079667855501619") }),
      withOver({ title: "Wieczór Grecki", source_url: url("4077491349052603") }),
    ], text);
    assert.deepEqual(kept.map((e) => e.title), ["Salsa na Placu Wolności"]);
  });

  it("rytm z drutu wystarcza za datę — terminy liczy shared/series.ts", () => {
    const kept = keepFoundedDates(
      [withOver({ title: "Wieczór Grecki", source_url: url("4077491349052603"), repeat: "co czwartek" })], text);
    assert.equal(kept.length, 1);
  });

  it("bez dowiązania po adresie sądzi po CAŁOŚCI — zwykła strona nie może tracić wydarzeń", () => {
    const page = "Kalendarz imprez\n\nKoncert w amfiteatrze\n\n21 sierpnia, wstęp wolny";
    assert.equal(keepFoundedDates([withOver({ source_url: "https://gok.pl/kalendarz" })], page).length, 1);
    assert.equal(keepFoundedDates([withOver({ source_url: "https://gok.pl/kalendarz" })], "Oferta stała, zapraszamy").length, 0);
  });
});
