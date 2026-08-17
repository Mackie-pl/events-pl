/**
 * Widoczność podziału na bloki. Testujemy to, czego złamanie jest ciche: krok śladu jest
 * observability, więc nikt się nie wywróci, gdy przestanie nieść liczby — po prostu pewnego
 * dnia nie da się odpowiedzieć, czemu strona bez zmian kosztowała.
 *
 * Stąd asercje na KONKRETNE liczby w detalach, a nie na obecność kroku: „krok jest" spełnia
 * też krok pusty.
 */
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { toBlock } from "../src/pipeline/extract/blocks.js";
import { auditBlockResult, auditNearMiss, auditSplit } from "../src/pipeline/extract/block-trail.js";
import { segmentHtml } from "../src/pipeline/extract/dom-blocks.js";
import { audit, auditTrails, beginAuditRun, beginAuditSource } from "../src/shared/audit.js";
import type { AuditStep, PipelineState } from "../src/types/index.js";

import { event } from "./helpers.js";

const steps = (): AuditStep[] => auditTrails().find((t) => t.id === "zamek")?.steps ?? [];
const stepOf = (kind: string): AuditStep | undefined => steps().find((s) => s.step === kind);
/** Detal kroku bez łańcucha `?.` w każdej asercji — inaczej test tonie w interpunkcji. */
const detail = (kind: string, key: string): unknown => stepOf(kind)?.detail?.[key];
const note = (kind: string): string => stepOf(kind)?.note ?? "";

const state = (): PipelineState => ({ hashes: {}, geo: {}, blocks: {} });

beforeEach(() => {
  beginAuditRun();
  beginAuditSource("zamek");
});

describe("ślad podziału na bloki", () => {
  const cached = toBlock("Blok, który stoi na stronie od tygodnia i nic w nim się nie zmieniło.");
  const fresh = toBlock("Nowa karta: Koncert Kwadrofonik, 12 sierpnia 2026, godz. 19:00.");

  it("krok podziału niesie znaki, nie tylko liczbę bloków", () => {
    auditSplit({ how: "DOM, 2 kart", url: "https://example.test/" }, [cached, fresh], [fresh]);

    assert.equal(detail("block", "blocks"), 2);
    assert.equal(detail("block", "cached"), 1);
    assert.equal(detail("block", "fresh"), 1);
    // znaki są tu sednem: „1 z 2 bloków" nie mówi, czy płacimy za nagłówek, czy za pół strony
    assert.equal(detail("block", "chars"), cached.chars + fresh.chars);
    assert.equal(detail("block", "freshChars"), fresh.chars);
    assert.match(note("block"), /do modelu/u);
  });

  it("wejście HTML-a i rozliczenie kart wchodzą do detali, gdy strona przez DOM przeszła", () => {
    const seg = segmentHtml(HTML_LIST);
    auditSplit(
      { how: "DOM", url: "https://example.test/", htmlChars: HTML_LIST.length, dom: seg },
      seg.blocks, [],
    );

    assert.equal(detail("block", "htmlChars"), HTML_LIST.length);
    assert.equal(detail("block", "cards"), seg.cards);
    assert.ok((detail("block", "cardChars") as number) > 0, "karty bez znaków");
  });

  it("domknięcie rozdziela wydarzenia z cache'a od tych, za które dziś zapłaciliśmy", async () => {
    const st = state();
    st.blocks![cached.hash] = {
      events: [event(), event()], followups: [], at: "2026-08-01", seen: "2026-08-15",
    };
    st.blocks![fresh.hash] = {
      events: [event()], followups: ["https://example.test/plakat.jpg"],
      at: "2026-08-15", seen: "2026-08-15",
    };

    await auditBlockResult(
      { how: "DOM", url: "https://example.test/" }, [cached, fresh], [fresh], st,
    );

    assert.equal(detail("block.parsed", "fromFresh"), 1);
    assert.equal(detail("block.parsed", "fromCached"), 2);
    assert.equal(detail("block.parsed", "followups"), 1);
    assert.equal(detail("block.parsed", "silent"), 0);
  });

  it("liczy bloki, za które zapłaciliśmy bez ani jednego wydarzenia", async () => {
    const st = state();
    st.blocks![fresh.hash] = { events: [], followups: [], at: "2026-08-15", seen: "2026-08-15" };

    await auditBlockResult({ how: "akapity", url: "https://example.test/" }, [fresh], [fresh], st);

    // to jest cała diagnoza „strona się rusza, ale nie w wydarzeniach" — menu, licznik, banner
    assert.equal(detail("block.parsed", "silent"), 1);
    // sztuki nie wystarczą: płacimy za znaki, więc jałowość musi być mierzona znakami
    assert.equal(detail("block.parsed", "silentChars"), fresh.chars);
    assert.equal(detail("block.parsed", "freshChars"), fresh.chars);
    assert.match(note("block.parsed"), /% świeżej treści/u);
  });

  /**
   * Blok, który nie dał wydarzenia, ale wskazał plakat, NIE jest stratą — jego skutek widać
   * dopiero w followupie. Bez tego rozróżnienia strona-rozdzielacz (same linki do wydarzeń)
   * wychodzi na najgorsze źródło w rejestrze, choć robi dokładnie to, po co ją dodaliśmy.
   */
  it("jałowy blok, który wskazał followup, jest liczony osobno", async () => {
    const st = state();
    const bare = toBlock("Stopka: Gminny Ośrodek Kultury, ul. Krótka 1, tel. w zakładce Kontakt.");
    st.blocks![fresh.hash] = {
      events: [], followups: ["https://example.test/plakat.jpg"],
      at: "2026-08-15", seen: "2026-08-15",
    };
    st.blocks![bare.hash] = { events: [], followups: [], at: "2026-08-15", seen: "2026-08-15" };

    await auditBlockResult(
      { how: "akapity", url: "https://example.test/" }, [fresh, bare], [fresh, bare], st,
    );

    assert.equal(detail("block.parsed", "silent"), 2);
    assert.equal(detail("block.parsed", "silentLeads"), 1);
    assert.equal(detail("block.parsed", "silentChars"), fresh.chars + bare.chars);
  });

  it("bez archiwum krok nie udaje, że ma co pokazać", async () => {
    await auditBlockResult({ how: "akapity", url: "https://example.test/" }, [fresh], [], state());
    assert.equal(detail("block.parsed", "archive"), undefined);
  });

  /**
   * Dzień w pełni z cache'a i tak ma się rozliczyć w śladzie — archiwum jest wtedy pomijane
   * (patrz block-trail.ts), ale KROK zostaje: „nic nie poszło do modelu, a wydarzenia są"
   * to odpowiedź, nie brak odpowiedzi.
   */
  it("dzień w pełni z cache'a nadal melduje, co dał cache", async () => {
    const st = state();
    st.blocks![cached.hash] = {
      events: [event()], followups: [], at: "2026-08-01", seen: "2026-08-15",
    };
    await auditBlockResult({ how: "DOM", url: "https://example.test/" }, [cached], [], st);

    assert.equal(detail("block.parsed", "fromFresh"), 0);
    assert.equal(detail("block.parsed", "fromCached"), 1);
  });
});

/** Lista kart w kształcie, który podział po DOM-ie rozpoznaje (patrz dom-blocks.test.ts). */
const HTML_LIST = `<!doctype html><html><body><main>
  <h2>Nadchodzące wydarzenia</h2>
  ${["Peregrinus", "Kwadrofonik", "Lautari", "Bastarda"]
    .map((t) => `<article class="event"><h3>${t}</h3>
      <p>Opis wydarzenia ${t}, w którym stoi tyle tekstu, ile zwykle stoi w zajawce karty.</p>
      </article>`)
    .join("\n")}
</main></body></html>`;

/** Kafelki krótsze niż próg karty: liczebność listy, rozmiar menu. */
const HTML_TILES = `<!doctype html><html><body><main>
  <div class="tiles">
    ${["Aktualności", "Kontakt", "O nas", "Galeria", "Zapisy"]
    .map((t) => `<div class="tile"><a href="/${t}">${t}</a></div>`)
    .join("\n")}
  </div>
  <p>Zapraszamy do Gminnego Ośrodka Kultury. Program na sierpień w zakładce Aktualności.</p>
</main></body></html>`;

describe("czemu strona nie jest listą kart", () => {
  it("odrzucone grupy rodzeństwa wychodzą z podziału z powodem", () => {
    const seg = segmentHtml(HTML_TILES);
    assert.equal(seg.detected, false);
    const miss = seg.nearMiss.find((m) => m.sig.includes("tile"));
    assert.ok(miss, `żadna grupa nie została odnotowana: ${JSON.stringify(seg.nearMiss)}`);
    assert.equal(miss.n, 5);
    assert.match(miss.why, /poniżej progu karty/u);
  });

  it("krok pojawia się tylko wtedy, gdy było co odrzucać", () => {
    auditNearMiss(segmentHtml(HTML_TILES));
    assert.match(note("block"), /bez kart mimo/u);

    beginAuditRun();
    beginAuditSource("zamek");
    // strona z rozpoznaną listą nie ma się z czego tłumaczyć
    auditNearMiss(segmentHtml(HTML_LIST));
    audit("done", "gotowe");
    assert.equal(stepOf("block"), undefined);
  });
});
