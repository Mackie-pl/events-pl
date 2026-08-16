/**
 * Pobranie postów z FANPAGE'A FB (`fetch: "fb"`) — osobny dataset Bright Data niż grupy.
 *
 * Po co w ogóle: fanpage'e leżą w rejestrze pomijane od pierwszego dnia, z powodem czysto
 * wykonawczym („inny dataset, poza zakresem daily"), więc nigdy nie sprawdziliśmy, czy
 * instytucje ogłaszają się tam rzeczy, których nie ma nigdzie indziej. Dopóki tego nie
 * wiadomo, kanał FB składa się wyłącznie z tablic ogłoszeń — a te płacimy od POSTU, nie
 * od wydarzenia (pomiar 2026-08-16: 421 rekordów na 72 wydarzenia).
 *
 * TEN MODUŁ NIE ZMIENIA RACHUNKU ZA CRONA. `daily.ts` pomija `fetch:"fb"` zanim w ogóle
 * dojdzie do `processSource`, niezależnie od tego, czy dataset jest ustawiony. Jedynym
 * wejściem tutaj jest sonda `probe-fb-pages`, która niczego nie zapisuje.
 *
 * Rekordy postów fanpage'a mają tę samą rodzinę pól co posty grup (Bright Data trzyma jeden
 * kształt dla obu scraperów FB), więc spłaszczanie i statystyki idą przez `facebook.ts` bez
 * duplikatu. Gdyby dostawca to rozjechał, objawi się to zerowym plonem przy niezerowych
 * rekordach — i widać to w tabeli sondy jako `posty: 0`.
 */
import { BD_DATASETS, bdUsage, collect as bdCollect } from "../../adapters/brightdata.js";
import type { Fetched } from "../../adapters/page-fetch.js";
import { archiveRaw } from "../../adapters/supabase-archive.js";
import { P } from "../../config/index.js";
import type { EventOrigin, Source, SourceRun } from "../../types/index.js";
import {
  fbGroupPostsToBlocks, fbGroupPostsToText, fbGroupStats, fbOriginsByPost, fbPostExtras,
  fbShareStats,
} from "../facebook.js";

import { auditFbGroup, auditFbOrigins, auditFbPostExtras, auditFbShares } from "./fb-group-trail.js";

/** Limit rekordów na jeden fanpage. Stały — regulator pokrycia jest sterowany historią,
 *  której sonda z definicji nie ma (i nie zapisuje). */
export const fbPageLimit = (): number => P.PROBE_FB_PAGE_LIMIT.get();

/** Sufit rekordów na całą sondę — bezpiecznik ponad limitem per fanpage. */
export const fbPageBudget = (): number => P.PROBE_FB_MAX_RECORDS.get();

/**
 * Czy da się w ogóle sondować fanpage'e. Brak id datasetu to nie awaria, tylko brak decyzji
 * właściciela — zgadnięte id u dostawcy per-rekord albo nie zadziała, albo zescrapuje coś
 * innego za pieniądze, więc wartości domyślnej celowo nie ma.
 */
export const fbPageDatasetReady = (): boolean => Boolean(BD_DATASETS.fbPagePosts);

export const FB_PAGE_DATASET_MISSING =
  "Brak BD_DATASET_FB_PAGE_POSTS — id scrapera postów z fanpage'y trzeba wziąć z panelu "
  + "Bright Data (Web Scrapers → Facebook → posty profilu/strony). Bez niego sonda nie ruszy, "
  + "bo zgadywanie id u dostawcy rozliczanego per-rekord kosztuje bez gwarancji, że scrapuje "
  + "to, o co prosimy.";

/**
 * Jedno pobranie fanpage'a. Zwraca też mapę „post → oryginał udostępnienia", bo wiązanie
 * wydarzenia z adresem konkretnego postu istnieje wyłącznie w surowych rekordach — po
 * spłaszczeniu do tekstu dla modelu nie ma już czego wiązać.
 */
export async function fetchFbPage(
  src: Source, url: string, run: SourceRun,
): Promise<{ fetched: Fetched; origins: Map<string, EventOrigin> }> {
  if (!fbPageDatasetReady()) throw new Error(FB_PAGE_DATASET_MISSING);
  const limit = fbPageLimit();
  try {
    const records = await bdCollect(BD_DATASETS.fbPagePosts, [url], limit);
    const bdRaw = await archiveRaw(
      `${src.id}__bd`, url, JSON.stringify(records, null, 1), "fb",
    );
    // te same pomiary co dla grup i z tego samego powodu: po spłaszczeniu do tekstu daty
    // postów, obrazy i miejsca są już tylko napisem, z którego nikt ich nie policzy
    run.fbGroup = fbGroupStats(records, limit);
    auditFbGroup(run.fbGroup, bdRaw);
    auditFbPostExtras(fbPostExtras(records), run.fbGroup.posts);
    auditFbShares(fbShareStats(records));
    const origins = fbOriginsByPost(records);
    auditFbOrigins(origins.size, run.fbGroup.posts);
    return {
      fetched: {
        kind: "html",
        text: fbGroupPostsToText(records),
        blocks: fbGroupPostsToBlocks(records),
        httpStatus: 200,
      },
      origins,
    };
  } catch (e) {
    bdUsage.errors += 1;
    throw e;
  }
}
