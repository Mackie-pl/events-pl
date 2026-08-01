/**
 * Kontrakt rejestru na ŻYWYCH danych: sprzeczności, których potok nie powinien produkować.
 *
 * Każda asercja opisuje regułę, nie stan konkretnego źródła — i każda kończy się zdaniem
 * o tym, co zmienić w POTOKU. Poprawianie sources.json ręcznie zamiast tego jest zabronione:
 * zniknie przy najbliższym przebiegu, a przyczyna zostanie.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { harvestById } from "../../src/pipeline/discover/reconcile.js";
import { host } from "../../src/shared/url.js";

import { dailyRuns, report, sourcesFile } from "./helpers.js";

import type { Source } from "../../src/types/index.js";

const sources = sourcesFile()?.sources ?? [];

/** Zdolności z datami przy źródle uznanym za martwe — sprzeczność opisana niżej. */
const datedCapabilities = (s: Source): string[] =>
  (s.capabilities ?? [])
    .filter((c) => c.datesParsed > 0)
    .map((c) => `${s.id}: dead, ale ${c.kind} oddaje ${c.datesParsed}/${c.itemsSeen} z datami (${c.url})`);

/** Entrypointy wskazujące inny serwis niż samo źródło. */
const foreignEntrypoints = (s: Source): string[] =>
  (s.entrypoints ?? [])
    .filter((e) => host(e.url) !== host(s.url))
    .map((e) => `${s.id}: źródło na ${host(s.url)}, entrypoint na ${host(e.url)} (${e.url})`);

describe("rejestr — sprzeczności między werdyktem a dowodami", () => {
  it("źródło oznaczone `dead` nie trzyma zdolności, która oddaje daty", { skip: !sources.length }, () => {
    // dk-pod-lipami (2026-07-30): dead:true, a obok tribe 10/10 z datami. Adres naprawiono,
    // sprofilowano, potwierdzono trzy działające endpointy — i zabito werdyktem modelu
    // o stronie kategorii. Jedno wywołanie LLM przebiło trzy udane pobrania.
    const offenders = sources.filter((s) => s.dead).flatMap(datedCapabilities);

    assert.equal(offenders.length, 0, report(
      "martwe źródło z działającą zdolnością",
      offenders,
      "werdykt modelu o STRONIE nie może przebijać potwierdzonego pobrania: w `attachProfile` " +
      "(pipeline/verify/verify-source.ts) pominąć `markDead`, gdy profil znalazł zdolność " +
      "z `datesParsed > 0` — ekstrakcja i tak pójdzie przez `from-capability`, nie przez HTML.",
    ));
  });

  it("źródło oznaczone `dead` nie plonowało w oknie runs.json", { skip: !sources.length }, () => {
    const harvest = harvestById(dailyRuns());
    const offenders = sources
      .filter((s) => s.dead && (harvest.get(s.id) ?? 0) > 0)
      .map((s) => `${s.id}: dead, a w oknie runs.json ${harvest.get(s.id)} wydarzeń`);

    assert.equal(offenders.length, 0, report(
      "martwe źródło, które nadal plonuje",
      offenders,
      "plon jest mocniejszym dowodem niż drabina — `verifySource` powinno zdejmować `dead` " +
      "z każdego źródła, które w zachowanym oknie runs.json dało choć jedno wydarzenie.",
    ));
  });

  it("źródło `inactive` nie plonowało w oknie runs.json", { skip: !sources.length }, () => {
    const harvest = harvestById(dailyRuns());
    const offenders = sources
      .filter((s) => s.inactive && (harvest.get(s.id) ?? 0) > 0)
      .map((s) => `${s.id}: inactive, a w oknie runs.json ${harvest.get(s.id)} wydarzeń`);

    assert.equal(offenders.length, 0, report(
      "zdegradowane źródło, które plonuje",
      offenders,
      "`reconcile()` ma weto plonu wbudowane — jeśli to wystąpiło, okno runs.json przesunęło się " +
      "po degradacji. Sprawdzić kolejność: reconcile musi czytać runs.json PRZED zapisem przebiegu.",
    ));
  });
});

describe("rejestr — proweniencja", () => {
  it("każde źródło wie, skąd się wzięło", { skip: !sources.length }, () => {
    const offenders = sources
      .filter((s) => !s.provenance)
      .map((s) => `${s.id} (${s.town}) — ${s.url}`);

    assert.equal(offenders.length, 0, report(
      "źródło bez proweniencji",
      offenders,
      "pełny przebieg `npm run discover -- --reset \"Poznań\" 15` odbudowuje rejestr wyłącznie " +
      "z trafień wyszukiwarki, a `confirm()` w pipeline/discover/discover-town.ts dopisuje " +
      "proweniencję każdemu adresowi, który discovery znajdzie ponownie. Do czasu takiego " +
      "przebiegu ten test opisuje dług, nie awarię.",
    ));
  });

  it("entrypoint prowadzi na ten sam serwis co źródło", { skip: !sources.length }, () => {
    // po naprawie adresu (redirect) entrypoint bywa zapisany sprzed przekierowania — wtedy
    // `url` jest naprawiony, a daily i tak wchodzi starym adresem
    const offenders = sources.flatMap(foreignEntrypoints);

    assert.equal(offenders.length, 0, report(
      "entrypoint na innym hoście niż źródło",
      offenders,
      "`profileSource` dostaje adres PO przekierowaniu, ale model odbija w odpowiedzi adres " +
      "pytany. `applyProfile` (pipeline/verify/profile.ts) powinno przepisywać origin " +
      "entrypointu na ten, pod którym treść faktycznie odpowiedziała — tak jak robi to " +
      "`rebase()` dla samego `Source.url`.",
    ));
  });
});

describe("rejestr — spójność stanu", () => {
  it("`dead` i `inactive` wykluczają się", { skip: !sources.length }, () => {
    const offenders = sources.filter((s) => s.dead && s.inactive).map((s) => s.id);

    assert.equal(offenders.length, 0, report(
      "źródło jednocześnie martwe i zdegradowane",
      offenders,
      "`reconcile()` pomija źródła z `dead` (patrz `eligible`), więc oba znaczniki naraz " +
      "znaczą, że któraś ścieżka je ustawia z pominięciem reconcile — znaleźć ją i uzgodnić.",
    ));
  });

  it("naprawiony adres nie zostawia po sobie pustej historii", { skip: !sources.length }, () => {
    const offenders = sources
      .filter((s) => s.previous_urls?.includes(s.url))
      .map((s) => `${s.id}: ${s.url} figuruje też w previous_urls`);

    assert.equal(offenders.length, 0, report(
      "aktualny adres wpisany we własną historię",
      offenders,
      "`markAlive` (pipeline/verify/verify-source.ts) dopisuje stary adres do `previous_urls` " +
      "tylko przy realnej zmianie — powtórka znaczy, że porównanie adresów przepuściło " +
      "identyczne wartości.",
    ));
  });
});
