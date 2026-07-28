/**
 * Ślad decyzyjny to observability, nie produkt — więc testujemy przede wszystkim to,
 * czego złamanie jest niewidoczne aż do przeglądu publicznego repo: bezpiecznik na
 * liczbę kroków i redakcję PII w notkach.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import {
  RUN_SCOPE, audit, auditFor, auditTrails, beginAuditRun, beginAuditSource,
} from "../src/shared/audit.js";
import { redactTrail } from "../src/reporting/audit-trail.js";
import { parseModelJson, resetDroppedNoDate } from "../src/pipeline/extract/extract.js";
import { newStats } from "../src/pipeline/pii.js";
import type { SourceTrail } from "../src/types/index.js";

const bySource = (id: string): SourceTrail | undefined => auditTrails().find((t) => t.id === id);

beforeEach(() => { beginAuditRun(); });

describe("zbieracz śladu", () => {
  it("przypisuje kroki do bieżącego źródła", () => {
    beginAuditSource("zamek");
    audit("fetch", "pobrane");
    beginAuditSource("kultura");
    audit("fetch", "pobrane");
    audit("done", "gotowe");

    assert.deepEqual(auditTrails().map((t) => t.id), ["zamek", "kultura"]);
    assert.equal(bySource("zamek")?.steps.length, 1);
    assert.equal(bySource("kultura")?.steps.length, 2);
  });

  it("nie pokazuje źródeł, które nic nie zgłosiły", () => {
    beginAuditSource("cichy");
    assert.deepEqual(auditTrails(), []);
  });

  it("auditFor trafia do obcego źródła, nie zmieniając bieżącego", () => {
    beginAuditSource("zamek");
    auditFor("kultura", "dedupe.dropped", "scalone");
    audit("done", "gotowe");

    assert.equal(bySource("kultura")?.steps[0]?.step, "dedupe.dropped");
    assert.deepEqual(bySource("zamek")?.steps.map((s) => s.step), ["done"]);
  });

  it("kroki niosą oś czasu i detale", () => {
    beginAuditSource("zamek");
    audit("llm", "ekstrakcja", { chars: 1200, events: 3 });
    const step = bySource("zamek")?.steps[0];
    assert.equal(typeof step?.ms, "number");
    assert.ok((step?.ms ?? -1) >= 0, "ms liczone od startu przebiegu");
    assert.deepEqual(step?.detail, { chars: 1200, events: 3 });
  });

  it("obcina ślad po limicie i liczy ucięte — bezpiecznik przed plikiem na megabajty", () => {
    beginAuditSource("gadatliwe");
    for (let i = 0; i < 260; i++) audit("geo", `miejsce ${i}`);
    const trail = bySource("gadatliwe");
    assert.equal(trail?.steps.length, 200);
    assert.equal(trail?.truncated, 60);
  });

  it("beginAuditRun czyści poprzedni przebieg", () => {
    beginAuditSource("zamek");
    audit("fetch", "pobrane");
    beginAuditRun();
    assert.deepEqual(auditTrails(), []);
  });

  it("kroki bez otwartego źródła lądują w zakresie przebiegu", () => {
    audit("pii", "redakcja");
    assert.equal(bySource(RUN_SCOPE)?.steps.length, 1);
  });
});

describe("emisja z potoku", () => {
  it("odrzucenie wydarzenia bez daty ląduje w śladzie razem z tytułem", () => {
    beginAuditSource("zamek");
    const r = parseModelJson(JSON.stringify({
      events: [
        { title: "Koncert", date_start: "2026-08-01", is_noise: false },
        { title: "Nowe ZOO — całoroczna atrakcja", date_start: null, is_noise: false },
      ],
    }));
    resetDroppedNoDate();

    assert.equal(r.events.length, 1);
    const steps = bySource("zamek")?.steps ?? [];
    assert.equal(steps.length, 1, "krok tylko dla odrzuconego, nie dla każdego wydarzenia");
    assert.equal(steps[0]?.step, "event.dropped");
    assert.ok(steps[0]?.note.includes("Nowe ZOO"), `bez tytułu w notce: ${steps[0]?.note}`);
  });
});

describe("redakcja śladu", () => {
  it("usuwa komórki i e-maile z notek oraz z detali", () => {
    beginAuditSource("zamek");
    audit("geo", "„Sala prób, zapisy 601234567\" — brak trafienia", {
      venue: "Sala prób, kontakt: ktos@example.com",
      hit: false,
    });

    const trails = auditTrails();
    redactTrail(trails, newStats());
    const step = trails[0]?.steps[0];
    assert.ok(!step?.note.includes("601234567"), `komórka w notce: ${step?.note}`);
    assert.ok(!String(step?.detail?.["venue"]).includes("ktos@example.com"), "e-mail w detalu");
    assert.equal(step?.detail?.["hit"], false, "wartości nietekstowe zostają nietknięte");
  });

  it("zostawia numer stacjonarny — to centrala instytucji, nie osoba", () => {
    beginAuditSource("zamek");
    audit("geo", "Dom kultury, tel. 618529100");
    const trails = auditTrails();
    redactTrail(trails);
    assert.ok(trails[0]?.steps[0]?.note.includes("618529100"));
  });
});
