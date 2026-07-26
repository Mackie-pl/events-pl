/** Weryfikacja jednego źródła: sonda → ewentualna naprawa → werdykt. */
import { searchState } from "../../adapters/brave.js";
import { describeError } from "../../shared/errors.js";
import { resetUsage, snapshotUsage } from "../../adapters/openrouter.js";
import { beginSource, sourcePaths } from "../../adapters/supabase-archive.js";
import { todayIso } from "../../shared/dates.js";
import { isFbFetch, urlKey } from "../../shared/url.js";
import type { Source, SourceVerification } from "../../types/index.js";

import { probeUrl } from "./probe.js";
import { findReplacementUrl } from "./repair.js";

/** Weryfikuje URL źródła i mutuje `src` (verified/checked/url/previous_urls/dead/notes). */
export async function verifySource(src: Source, isNew: boolean): Promise<SourceVerification> {
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
    // FB odpowiada login-wallem: 200 z treścią „zaloguj się" albo 403. Jedno i drugie
    // prowadziło do „naprawy" adresu przypadkowym wynikiem z wyszukiwarki albo do dead:true,
    // przez co daily przestawało odpytywać żywą grupę (skipped-dead).
    ver.outcome = "skipped";
    ver.note = `fetch:"${src.fetch}" — adresy FB nie odpowiadają na zwykły fetch`;
    // `checked` znaczy „URL potwierdzony jako działający tego dnia" — pominięcia nim nie znaczymy,
    // ślad zostaje w raporcie przebiegu (outcome: skipped + note)
    return finalize();
  }

  try {
    const probe = await probeUrl(src.url.replace("{page}", "1"));
    ver.probe = probe;
    if (probe.httpStatus !== undefined) ver.httpStatus = probe.httpStatus;
    if (isNew && src.provenance) src.provenance.firstFetch = probe;

    if (probe.ok) {
      src.verified = true;
      src.checked = todayIso();
      delete src.dead;
      return finalize();
    }
    ver.err = probe.err ?? "nieznany błąd";

    if (!process.env["BRAVE_API_KEY"] || searchState().disabled) {
      // bez wyszukiwarki nie próbujemy naprawy — i nie dotykamy źródła
      ver.outcome = "error";
      ver.err = `${ver.err}; ${searchState().disabled ?? "brak BRAVE_API_KEY"} — naprawa pominięta`;
      return finalize();
    }

    const candidate = await findReplacementUrl(src, ver);
    if (candidate) ver.candidate = candidate;
    if (candidate && urlKey(candidate) !== urlKey(src.url)) {
      const second = await probeUrl(candidate);
      ver.candidateProbe = second;
      if (second.ok) {
        src.previous_urls = [...(src.previous_urls ?? []), src.url];
        src.url = candidate;
        src.verified = true;
        src.checked = todayIso();
        delete src.dead;
        src.notes = `${src.notes ? src.notes + " | " : ""}URL naprawiony ${todayIso()} (stary w previous_urls)`;
        ver.outcome = "fixed";
        ver.newUrl = candidate;
        return finalize();
      }
      ver.err = `${ver.err}; kandydat ${candidate} też padł: ${second.err}`;
    }

    // naprawa się nie udała — oznacz jako martwe (daily pominie do następnego --verify)
    if (!src.dead) src.notes = `${src.notes ? src.notes + " | " : ""}martwy URL (${todayIso()}): ${probe.err}`;
    src.dead = true;
    src.verified = false;
    src.checked = todayIso();
    ver.outcome = "dead";
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
