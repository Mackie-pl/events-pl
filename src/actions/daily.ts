/**
 * Stage 2: codzienny pipeline ekstrakcji wydarzeń.
 * sources.json -> fetch -> diff -> LLM (Haiku) -> expand followups (PDF/podstrony/plakaty)
 * -> geocode -> dedupe -> events.json -> index.html
 *
 * Uruchomienie: ANTHROPIC_API_KEY=... npm run daily
 */
import { appendFile } from "node:fs/promises";

import { bdEnabled, bdUsage } from "../adapters/brightdata.js";
import { setCallRecorder } from "../adapters/openrouter.js";
import {
  archiveEnabled,
  archiveEventsFull,
  archiveLlmCall,
  archiveStats,
  beginRun,
} from "../adapters/supabase-archive.js";
import { P } from "../config/index.js";
import { withoutCamps } from "../pipeline/camps.js";
import { DEDUPE_WHY, dedupe } from "../pipeline/dedupe.js";
import { harvestEventUrls, isEventUrl } from "../pipeline/facebook.js";
import { pruneBlocks } from "../pipeline/extract/block-cache.js";
import { resolveFbEvents } from "../pipeline/extract/fb-events.js";
import { applyFbMutes, mutedSkip } from "../pipeline/extract/fb-cost-mute.js";
import { blockedSkip, recheckDays } from "../pipeline/extract/fb-group-blocked.js";
import {
  newSourceRun,
  processSource,
} from "../pipeline/extract/process-source.js";
import { redactEvents, redactText } from "../pipeline/pii.js";
import { foldSeries } from "../pipeline/series.js";
import { auditStore, redactTrail } from "../reporting/audit-trail.js";
import { costRates, recordCosts } from "../reporting/cost-ledger.js";
import { buildYield } from "../reporting/source-yield.js";
import { buildDailyCosts } from "../reporting/daily-costs.js";
import { buildReport, dailyRunsStore } from "../reporting/daily-report.js";
import { attachProduced } from "../reporting/event-refs.js";
import { fbValueLine, summaryLine, writeDailySummary } from "../reporting/daily-summary.js";
import { renderHtml } from "../reporting/render-index.js";
import {
  RUN_SCOPE,
  audit,
  auditFor,
  auditTrails,
  beginAuditRun,
  beginAuditSource,
} from "../shared/audit.js";
import { todayIso } from "../shared/dates.js";
import { BD_USAGE_LOG } from "../shared/paths.js";
import { eventsStore, sourcesStore, stateStore } from "../storage/index.js";
import type {
  EventItem,
  EventsFile,
  PipelineError,
  SourceRun,
} from "../types/index.js";

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  beginRun(startedAt);
  beginAuditRun();
  if (archiveEnabled()) {
    setCallRecorder(archiveLlmCall);
    console.log("archiwum: włączone (Supabase Storage)");
  }
  const cfg = await sourcesStore.load();
  const state = await stateStore.load();
  const errors: PipelineError[] = [];
  const sourceRuns: SourceRun[] = [];
  let allEvents: EventItem[] = [];
  // co dało każde źródło, zanim dedupe wybrał zwycięzców — jedyny moment, w którym to wiadomo
  const producedBy = new Map<SourceRun, EventItem[]>();
  // linki do wydarzeń FB zebrane po drodze (treści stron, followupy, posty grup) — rozwiązywane zbiorczo na końcu
  const fbEventUrls = new Set<string>();

  for (const src of cfg.sources) {
    beginAuditSource(src.id);
    if (
      src.fetch === "fb" ||
      ((src.fetch === "fb_group" || src.fetch === "fb_event") && !bdEnabled())
    ) {
      // fanpage: osobny dataset Bright Data, poza zakresem daily; fb_group/fb_event bez klucza → tryb zero-cost
      if (bdEnabled() && isEventUrl(src.url))
        for (const u of harvestEventUrls(src.url)) fbEventUrls.add(u);
      sourceRuns.push(
        newSourceRun(src, src.url.replace("{page}", "1"), "skipped-fb"),
      );
      audit(
        "skip",
        bdEnabled()
          ? `fanpage FB (fetch:„${src.fetch}") — inny dataset Bright Data, poza zakresem daily`
          : `źródło FB (fetch:„${src.fetch}") bez klucza Bright Data — tryb zero-cost`,
      );
      continue;
    }
    if (src.fetch === "fb_event") {
      // pojedynczy link do wydarzenia — dołącza do zbiorczego rozwiązania
      for (const u of harvestEventUrls(src.url)) fbEventUrls.add(u);
      const sr = newSourceRun(src, src.url, "skipped-fb");
      sr.note = "rozwiązywane zbiorczo — patrz wiersz fb-events";
      sourceRuns.push(sr);
      audit(
        "skip",
        "link do wydarzenia FB — dołącza do zbiorczego rozwiązania (patrz źródło fb-events)",
      );
      continue;
    }
    if (src.dead) {
      // martwy URL wg discover --verify — nie marnujemy fetcha do następnej naprawy
      sourceRuns.push(
        newSourceRun(src, src.url.replace("{page}", "1"), "skipped-dead"),
      );
      audit(
        "skip",
        "URL oznaczony jako martwy przez discover --verify — bez próby pobrania",
        { url: src.url },
      );
      continue;
    }
    if (src.inactive) {
      // adres żyje, ale discovery przestało go znajdować i nic z niego nie plonuje.
      // Wraca sam, gdy wyszukiwarka znowu go pokaże — dlatego pomijamy, a nie kasujemy.
      sourceRuns.push(
        newSourceRun(src, src.url.replace("{page}", "1"), "skipped-inactive"),
      );
      audit(
        "skip",
        `nieaktywne: ${src.missedRuns ?? 0} przebiegi discovery bez trafienia ` +
          "i zero wydarzeń — wróci przy pierwszym trafieniu",
        { url: src.url },
      );
      continue;
    }
    const muted = mutedSkip(src, state, todayIso());
    if (muted) {
      // powyżej progu opłacalności — wyciszone CZASOWO. Wpis wygasa sam w dniu `until`
      // i źródło wraca do pomiaru; nie ma tu decyzji trwałej.
      sourceRuns.push(
        newSourceRun(src, src.url.replace("{page}", "1"), "skipped-costly"),
      );
      audit(
        "skip",
        `powyżej progu opłacalności od ${muted.since}: ` +
          (muted.usdPerNovel === undefined
            ? `${muted.novel} wydarzeń spoza sieci za $${muted.costUsd.toFixed(4)}`
            : `$${muted.usdPerNovel.toFixed(4)} za wydarzenie spoza sieci`) +
          ` — wraca ${muted.until}`,
        { url: src.url, until: muted.until, novel: muted.novel },
      );
      continue;
    }
    const blocked = blockedSkip(src, state, todayIso());
    if (blocked) {
      // grupa oddaje sam wiersz błędu — płatny i pusty. Pomijamy, ale nie na zawsze:
      // sonda co `recheckDays()` dni jest jedyną drogą powrotu po ponownym otwarciu grupy.
      sourceRuns.push(
        newSourceRun(src, src.url.replace("{page}", "1"), "skipped-blocked"),
      );
      audit(
        "skip",
        `grupa FB niedostępna dla scrapera od ${blocked.since} ` +
          `(${blocked.runs} pobrań z samym wierszem błędu` +
          `${blocked.why ? `: „${blocked.why}"` : ""}) — kolejna sonda po ` +
          `${recheckDays()} dniach od ${blocked.lastTry}`,
        { url: src.url, runs: blocked.runs, since: blocked.since },
      );
      continue;
    }
    const { events, run: sr } = await processSource(
      src,
      state,
      errors,
      fbEventUrls,
    );
    sourceRuns.push(sr);
    producedBy.set(sr, events);
    allEvents.push(...events);
  }

  if (bdEnabled() && fbEventUrls.size) {
    beginAuditSource("fb-events");
    audit(
      "fetch",
      `${fbEventUrls.size} linków do wydarzeń FB — jedno zbiorcze zapytanie do Bright Data`,
    );
    const { events, run: fbRun } = await resolveFbEvents(
      [...fbEventUrls],
      state,
      errors,
    );
    sourceRuns.push(fbRun);
    producedBy.set(fbRun, events);
    allEvents.push(...events);
    audit(
      "done",
      `status „${fbRun.status}" — ${events.length} wydarzeń idzie do scalania`,
      { status: fbRun.status, events: events.length },
    );
  }

  beginAuditSource(RUN_SCOPE);
  // po wszystkich źródłach, nie w trakcie: `seen` bloku ustawia się dopiero przy jego
  // odwiedzeniu, więc przycinanie w środku pętli skasowałoby bloki źródeł jeszcze nietkniętych
  pruneBlocks(state);
  // przed scalaniem, bo półkolonie potrafią przyjść z dwóch źródeł naraz i wtedy dedupe
  // wybierałby zwycięzcę spośród rekordów, z których żaden nie ma prawa się opublikować
  allEvents = withoutCamps(allEvents);
  const merged = dedupe(allEvents);
  allEvents = merged.events;
  // przegrany trafia do śladu SWOJEGO źródła — tam go szuka ktoś, kto pyta „czemu to zniknęło?"
  for (const d of merged.dropped) {
    auditFor(
      d.loser.source_id ?? RUN_SCOPE,
      "dedupe.dropped",
      `„${d.loser.title}" scalone do „${d.winner.title}" ze źródła „${d.winner.source_id ?? "?"}" ` +
        `(${DEDUPE_WHY[d.why]})`,
      {
        title: d.loser.title,
        date: d.loser.date_start,
        winner: d.winner.source_id ?? null,
        why: d.why,
      },
    );
  }
  audit(
    "dedupe.dropped",
    `scalanie: ${merged.dropped.length} duplikatów, zostaje ${allEvents.length} wydarzeń`,
    { dropped: merged.dropped.length, kept: allEvents.length },
  );

  // dopiero PO dedupe: tamto scala to samo wydarzenie w tym samym dniu z różnych źródeł,
  // to scala te same wydarzenia w różnych dniach. Odwrotna kolejność zwijałaby w serię
  // duplikaty międzyźródłowe.
  const folded = foldSeries(allEvents);
  allEvents = folded.events;
  if (folded.dropped.length) {
    audit(
      "series",
      `serie: ${folded.dropped.length} powtórzeń zwiniętych, ` +
        `zostaje ${allEvents.length} wydarzeń`,
      { folded: folded.dropped.length, kept: allEvents.length },
    );
  }

  // pełna wersja (z kontaktami) do prywatnego archiwum — MUSI polecieć przed redakcją
  await archiveEventsFull({
    generated: new Date().toISOString().slice(0, 10),
    startedAt,
    events: allEvents,
    errors,
  });

  // PII wychodzi tuż przed zapisem: dedupe pracuje na pełnych danych, a do repo (events.json,
  // index.html, runs.json, job summary) trafia już wersja zredagowana. Komunikaty błędów też —
  // potrafią nieść fragment treści strony.
  const pii = redactEvents(allEvents);
  // state.json też jest w repo — cache ekstrakcji trzyma wydarzenia, więc redagujemy i jego.
  // Redakcja jest idempotentna, a część obiektów jest współdzielona z allEvents (to samo id w pamięci).
  for (const entry of Object.values(state.extractions ?? {}))
    redactEvents(entry.events);
  // cache bloków tak samo: te same wydarzenia, tylko zaadresowane treścią zamiast źródłem.
  // Pominięcie go byłoby wyciekiem kontaktów do publicznego repo tą samą drogą, którą
  // `extractions` zamknięto wcześniej.
  for (const entry of Object.values(state.blocks ?? {}))
    redactEvents(entry.events);
  for (const e of errors) e.err = redactText(e.err, pii);
  for (const sr of sourceRuns) {
    if (sr.err) sr.err = redactText(sr.err, pii);
    for (const fu of sr.followups) if (fu.err) fu.err = redactText(fu.err, pii);
  }
  // dopiero teraz: refy niosą tytuły, więc muszą powstać z rekordów PO redakcji.
  // Wchłonięci przez serię idą razem z przegranymi dedupe — z punktu widzenia raportu
  // źródła to ta sama odpowiedź: „dałeś ten rekord, wsiąkł w tamten".
  attachProduced(producedBy, [...merged.dropped, ...folded.dropped]);
  audit(
    "pii",
    `usunięto ${pii.phones} numerów komórkowych i ${pii.emails} adresów e-mail`,
    { phones: pii.phones, emails: pii.emails },
  );
  audit(
    "done",
    `publikacja: ${allEvents.length} wydarzeń, ${errors.length} błędów potoku`,
    { events: allEvents.length, errors: errors.length },
  );
  const out: EventsFile = {
    generated: new Date().toISOString().slice(0, 10),
    events: allEvents,
    errors,
  };
  if (bdEnabled()) out.brightdata = bdUsage;
  const report = buildReport(startedAt, t0, sourceRuns, pii);
  if (bdEnabled()) report.brightdata = bdUsage;
  // koszt liczymy po zbudowaniu raportu (ma już wszystkie źródła) i przed zapisem,
  // żeby ta sama rozpiska poszła do runs.json, costs.json i na stdout
  report.costs = buildDailyCosts(report, archiveStats().bytes);

  // Próg opłacalności FB. Okno to runs.json RAZEM z bieżącym przebiegiem — inaczej dzisiejszy
  // koszt wchodziłby do rachunku dopiero jutro, a wyciszenie zawsze spóźniało się o dobę.
  // Musi stać po `attachProduced` (bez `produced` nie ma czego przypisać źródłom) i przed
  // zapisem stanu, bo to on niesie wyciszenia do następnego przebiegu.
  const fbValue = applyFbMutes(
    buildYield([...(await dailyRunsStore.all()), report], costRates()).sources,
    state,
    todayIso(),
  );
  if (fbValue.length) report.fbValue = fbValue;

  // ślad niesie tytuły, miejsca i fragmenty błędów — audit.json leci do publicznego repo.
  // Migawka po WSZYSTKICH krokach: werdykty progu też są decyzjami i mają zostać w śladzie.
  const trails = auditTrails();
  redactTrail(trails, pii);

  await eventsStore.save(out);
  await stateStore.save(state);
  await dailyRunsStore.append([report]);
  // ślad idzie zaraz za raportem i z tą samą retencją — inaczej panel pokaże przebieg bez śladu
  await auditStore.append([
    { run: startedAt, day: out.generated, sources: trails },
  ]);
  await recordCosts(report.costs);
  await renderHtml(out, report);
  writeDailySummary(report);
  console.log(summaryLine(report));
  if (report.fbValue?.length) console.log(fbValueLine(report.fbValue));
  if (bdEnabled()) {
    // log zużycia per przebieg → policzenie kosztu
    // (snapshot_id pozwala ponownie pobrać dane z BD za darmo)
    const entry = {
      date: out.generated,
      at: new Date().toISOString(),
      ...bdUsage,
    };
    await appendFile(BD_USAGE_LOG, `${JSON.stringify(entry)}\n`, "utf-8");
    console.log(
      `Bright Data: ${bdUsage.triggers} trigger · ${bdUsage.inputs} URL · ${bdUsage.records} rekordów · ` +
        `${bdUsage.polls} polls · ${bdUsage.errors} błędów`,
    );
    if (bdUsage.errors > 0) {
      // pierwszy błąd wystarczy do diagnozy (401 vs timeout vs failed snapshot) — reszta jest zwykle tym samym
      const first =
        errors.find((e) => e.err.startsWith("Bright Data"))?.err ?? "?";
      // adnotacja GH Actions: bez niej przebieg z samymi błędami BD i tak kończy się zielonym haczykiem
      if (P.GITHUB_ACTIONS.get()) {
        console.log(
          `::warning::Bright Data: ${bdUsage.errors} błędów, pierwszy: ${first}`,
        );
      } else {
        console.log(`Bright Data pierwszy błąd: ${first}`);
      }
    }
  }
  if (archiveEnabled()) {
    const a = archiveStats();
    console.log(
      `archiwum: ${a.uploaded} obiektów (${(a.bytes / 1024 / 1024).toFixed(2)} MB)` +
        (a.failed ? `, ${a.failed} błędów` : ""),
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
