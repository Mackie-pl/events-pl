/** Weryfikacja jednego źródła: drabina osiągalności → naprawa → profil → werdykt. */
import { resetUsage, snapshotUsage } from "../../adapters/openrouter.js";
import { searchConfigured, searchState } from "../../adapters/search.js";
import { beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { todayIso } from "../../shared/dates.js";
import { describeError } from "../../shared/errors.js";
import { isFbFetch, urlKey } from "../../shared/url.js";
import type { ReachOutcome, Source, SourceVerification } from "../../types/index.js";

import { applyProfile, profileSource } from "./profile.js";
import { probeUrl } from "./probe.js";
import { probeReachable, type Reachability } from "./reach.js";
import { findReplacementUrl } from "./repair.js";

/**
 * Werdykty, po których adres jest trwale nie do uratowania POD TYM ADRESEM — a przy braku
 * wyszukiwarki po prostu trwale nie do uratowania.
 *
 * `dns-dead` osobno od reszty, bo to jedyny objaw, który rozstrzyga się BEZ pytania kogokolwiek:
 * domena się nie rozwiązuje, więc nie ma czego naprawiać ani czym potwierdzać. Wcześniej brak
 * klucza API kończył się `outcome: "error"` z nietkniętym źródłem i sześć nieistniejących domen
 * było odpytywanych przez `daily` codziennie, bez końca.
 */
const HOPELESS: ReadonlySet<ReachOutcome> = new Set<ReachOutcome>(["dns-dead"]);

/** Oznaczenie źródła jako martwego wraz z notatką — jedno miejsce, bo woła je kilka ścieżek. */
function markDead(src: Source, why: string): void {
  if (!src.dead) src.notes = `${src.notes ? src.notes + " | " : ""}martwy URL (${todayIso()}): ${why}`;
  src.dead = true;
  src.verified = false;
  src.checked = todayIso();
}

/**
 * Weto plonu: źródło, które w zachowanym oknie runs.json dało wydarzenia, nie może zostać
 * uznane za martwe.
 *
 * To nie jest ostrożność na wyrost, tylko wyjście ze spirali. `daily` pobiera stronę pełnym
 * potokiem (strategia z `fetch`, nagłówki, w razie potrzeby przeglądarka), a weryfikacja
 * sondą `probeUrl`. Gdy sonda przegrywa tam, gdzie potok wygrywa, źródło dostaje `dead:true`,
 * `daily` przestaje je odpytywać (`skipped-dead`) — i jedyny dowód, że żyło, przestaje
 * powstawać. Plon jest twardszy niż jakikolwiek werdykt sondy czy modelu, więc rozstrzyga.
 */
function harvestVeto(src: Source, ver: SourceVerification, harvested: number): boolean {
  if (harvested <= 0) return false;
  ver.outcome = "error";
  ver.note = `sonda nie potwierdziła adresu, ale źródło dało ${harvested} wydarzeń ` +
    "w oknie runs.json — nie oznaczamy jako martwe";
  return true;
}

/**
 * Adres do zapisania w rejestrze po udanym sprawdzeniu.
 *
 * Dwie pułapki naraz:
 *  - porównanie MUSI być dosłowne, nie przez `urlKey` — ten celowo ignoruje schemat i `www.`
 *    (dla dedupe rejestru `http://x` i `https://www.x/` to jedno źródło), więc zejście
 *    z wygasłego https na http nie wyglądało na zmianę i naprawa cicho nie zapisywała się;
 *  - `Source.url` bywa szablonem z `{page}`, a sondujemy adres z podstawioną jedynką. Gdy
 *    zmienił się tylko origin, przenosimy go do szablonu zamiast zapisywać rozwinięty adres —
 *    inaczej naprawa schematu kasowałaby paginację.
 */
export function rebase(template: string, resolved: string, probed: string): string {
  if (resolved === probed) return template;
  try {
    const r = new URL(resolved);
    const p = new URL(probed);
    if (r.pathname === p.pathname && r.search === p.search) return template.replace(p.origin, r.origin);
  } catch { /* któryś adres nie do rozłożenia — bierzemy to, co odpowiedziało */ }
  return resolved;
}

/** Zapis udanego sprawdzenia: adres, strategia, data i skasowanie flagi `dead`. */
function markAlive(src: Source, reach: Reachability, probed: string): void {
  const url = rebase(src.url, reach.url, probed);
  if (url !== src.url) {
    src.previous_urls = [...(src.previous_urls ?? []), src.url];
    src.url = url;
  }
  if (reach.fetch !== src.fetch) src.fetch = reach.fetch;
  src.reach = reach.outcome;
  src.verified = true;
  src.checked = todayIso();
  delete src.dead;
}

/** Werdykty kandydata, po których naprawa jest nieudana (serwer nie oddał użytecznej treści). */
const CANDIDATE_FAILED: ReadonlySet<ReachOutcome> =
  new Set<ReachOutcome>(["dns-dead", "http-error", "placeholder"]);

/** Próba naprawy przez wyszukiwarkę. Zwraca `true`, gdy źródło zostało naprawione. */
async function repair(src: Source, ver: SourceVerification): Promise<boolean> {
  const candidate = await findReplacementUrl(src, ver);
  if (candidate) ver.candidate = candidate;
  if (!candidate || urlKey(candidate) === urlKey(src.url)) return false;

  // kandydat też przechodzi całą drabinę: wynik z wyszukiwarki bywa http-em albo za WAF-em
  const second = await probeReachable(candidate, src.fetch);
  ver.candidateProbe = second.probe;
  if (CANDIDATE_FAILED.has(second.outcome)) {
    ver.err = `${ver.err ?? ""}; kandydat ${candidate} też padł: ${second.probe.err ?? second.outcome}`;
    return false;
  }
  markAlive(src, second, src.url);
  src.notes = `${src.notes ? src.notes + " | " : ""}URL naprawiony ${todayIso()} (stary w previous_urls)`;
  ver.outcome = "fixed";
  ver.newUrl = second.url;
  return true;
}

/**
 * Rozpoznanie entrypointów i zdolności — po potwierdzeniu, że adres żyje.
 *
 * `verdict:"none"` kasuje wyłącznie źródło ŚWIEŻO zaproponowane. Dla źródła, które już jest
 * w rejestrze, zostaje notatką — i to nie jest ostrożność na wyrost: w pierwszym przebiegu
 * profilera model zawetował `swarzedz-city`, które w ostatnim `daily` dało 10 wydarzeń.
 * Model ogląda jedną stronę przez chwilę, a `daily` ma miesiące dowodów z tego samego adresu;
 * przy sprzeczności to nie model wygrywa.
 */
async function attachProfile(
  src: Source, ver: SourceVerification, url: string, isNew: boolean,
): Promise<void> {
  const profile = await profileSource(src, url);
  applyProfile(src, profile);
  if (profile.entrypoints.length) ver.entrypoints = profile.entrypoints;
  if (profile.capabilities.length) ver.capabilities = profile.capabilities;
  if (profile.verdict) ver.verdict = profile.verdict;
  if (profile.verdict !== "none") return;

  const why = profile.why ?? "model nie znalazł na tej stronie wydarzeń";
  // Zdolność z datami przebija werdykt o STRONIE. Model ocenia HTML, a ekstrakcja i tak
  // pójdzie przez `from-capability` — feed z terminami jest dowodem z pobrania, nie opinią.
  // Bez tego `dk-pod-lipami` i `dk-orbita` wylądowały jako `dead` z działającym tribe 10/10.
  const dated = profile.capabilities.find((c) => c.datesParsed > 0);
  if (dated) {
    ver.note = `model nie widzi wydarzeń na stronie (${why}), ale ${dated.kind} oddaje ` +
      `${dated.datesParsed}/${dated.itemsSeen} z datami — źródło zostaje`;
    return;
  }
  if (isNew) {
    markDead(src, why);
    ver.outcome = "dead";
    ver.err = why;
    return;
  }
  ver.note = `model nie widzi tu wydarzeń: ${why} — źródło zostaje, rozstrzyga plon w daily`;
  src.notes = `${src.notes ? src.notes + " | " : ""}${todayIso()}: ${why}`;
}

/** Adres odpowiedział — zapis stanu i profil. */
async function onReachable(
  src: Source, ver: SourceVerification, reach: Reachability, ctx: { probed: string; isNew: boolean },
): Promise<void> {
  const { probed, isNew } = ctx;
  const moved = reach.url !== probed || reach.fetch !== src.fetch;
  markAlive(src, reach, probed);
  if (moved) {
    ver.outcome = "fixed";
    ver.newUrl = reach.url;
    ver.note = `drabina: ${reach.outcome}${reach.fetch !== "plain" ? ` → fetch:"${reach.fetch}"` : ""}`;
  }
  await attachProfile(src, ver, reach.url, isNew);
}

/**
 * Adres nie odpowiedział — rozstrzygnięcie: naprawa, martwy, czy błąd do następnego razu.
 *
 * Kolejność jest istotna i była już raz zła: `dns-dead` NIE może zwierać obiegu przed naprawą.
 * Martwa domena nie znaczy martwej instytucji — Serper na zapytanie o GOKiS Kleszczewo oddaje
 * `gokis.kleszczewo.pl`, podczas gdy rejestr trzyma nieistniejące `gokis-kleszczewo.pl`.
 * Właśnie takie przypadki naprawa ma łapać, więc próbujemy jej ZAWSZE, gdy jest czym szukać.
 *
 * Rozstrzygnięcie bez wyszukiwarki zostaje nietknięte: `dns-dead` → `dead` (nie ma czego
 * potwierdzać), cokolwiek innego → `error` (serwer odpowiadał, może wrócić).
 */
async function onUnreachable(
  src: Source, ver: SourceVerification, reach: Reachability, ctx: { isNew: boolean; harvested: number },
): Promise<void> {
  ver.err = reach.probe.err ?? reach.outcome;
  const canSearch = searchConfigured() && !searchState().disabled;

  if (canSearch && await repair(src, ver)) {
    await attachProfile(src, ver, src.url, ctx.isNew);
    return;
  }
  if (!canSearch && !HOPELESS.has(reach.outcome)) {
    ver.outcome = "error";
    ver.err = `${ver.err}; ${searchState().disabled ?? "brak klucza wyszukiwarki"} — naprawa pominięta`;
    return;
  }
  if (harvestVeto(src, ver, ctx.harvested)) return;
  // naprawa nie dała adresu albo nie ma czym szukać, a objaw jest bezsporny
  markDead(src, ver.err);
  ver.outcome = "dead";
}

/** Adresy FB nie odpowiadają na zwykły fetch (login-wall) — weryfikacja ich nie dotyczy. */
function skipFacebook(src: Source, ver: SourceVerification): void {
  // 200 z treścią „zaloguj się" albo 403. Jedno i drugie prowadziło do „naprawy" adresu
  // przypadkowym wynikiem z wyszukiwarki albo do dead:true, przez co daily przestawało
  // odpytywać żywą grupę (skipped-dead).
  ver.outcome = "skipped";
  ver.note = `fetch:"${src.fetch}" — adresy FB nie odpowiadają na zwykły fetch`;
  // `checked` znaczy „URL potwierdzony jako działający tego dnia" — pominięcia nim nie znaczymy,
  // ślad zostaje w raporcie przebiegu (outcome: skipped + note)
}

/** Przepisanie wyniku sondy do raportu — pięć pól, które i tak zawsze idą razem. */
function recordProbe(
  src: Source, ver: SourceVerification, reach: Reachability, isNew: boolean,
): void {
  ver.probe = reach.probe;
  ver.reach = reach.outcome;
  if (reach.ladder.length > 1) ver.ladder = reach.ladder;
  if (reach.probe.httpStatus !== undefined) ver.httpStatus = reach.probe.httpStatus;
  if (isNew && src.provenance) src.provenance.firstFetch = reach.probe;
}

/**
 * @param harvested ile wydarzeń dało to źródło w zachowanym oknie runs.json — weto wobec
 *   werdyktu `dead` (patrz `harvestVeto`). 0 dla źródeł nowych i dla wywołań spoza `discover`.
 */
export async function verifySource(
  src: Source, isNew: boolean, harvested = 0,
): Promise<SourceVerification> {
  const t0 = performance.now();
  resetUsage();
  beginSource(`verify-${src.id}`);
  const ver: SourceVerification = {
    id: src.id, name: src.name, town: src.town, url: src.url,
    outcome: "ok", searches: [], llm: snapshotUsage(), ms: 0,
    ...(isNew ? { isNew: true } : {}),
  };
  const finalize = (): SourceVerification => {
    ver.llm = snapshotUsage();
    ver.ms = Math.round(performance.now() - t0);
    const paths = sourcePaths();
    if (paths.length) ver.archive = paths;
    return ver;
  };

  if (isFbFetch(src.fetch)) {
    skipFacebook(src, ver);
    return finalize();
  }

  try {
    const probed = src.url.replace("{page}", "1");
    const reach = await probeReachable(probed, src.fetch);
    recordProbe(src, ver, reach, isNew);

    if (reach.probe.ok) await onReachable(src, ver, reach, { probed, isNew });
    else await onUnreachable(src, ver, reach, { isNew, harvested });
    return finalize();
  } catch (e) {
    // Wyjątek w naprawie (padnięty OpenRouter, timeout) nie może zabrać ze sobą reszty rejestru
    // ani tego, co już wiemy o TYM źródle: bez tego łapania ginęły jego zapytania i zużycie LLM,
    // a 45 pozostałych źródeł zostawało niesprawdzonych. Źródła nie oznaczamy — naprawa
    // nie dała odpowiedzi, więc `dead` byłoby zgadywaniem (daily przestałoby je odpytywać).
    ver.outcome = "error";
    ver.err = `${ver.err ? ver.err + "; " : ""}${describeError(e)}`;
    return finalize();
  }
}

/** Reeksport dla testów, które sprawdzają samą klasyfikację bez całej ścieżki weryfikacji. */
export { probeUrl };
