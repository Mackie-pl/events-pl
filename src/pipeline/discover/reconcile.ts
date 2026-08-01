/**
 * Rozliczenie rejestru z wynikami discovery: czego wyszukiwarka NIE znalazła i co z tym zrobić.
 *
 * Do tej pory źródło mogło umrzeć wyłącznie na drabinie osiągalności — czyli tylko wtedy, gdy
 * serwer przestał odpowiadać. Serwis, który po prostu wypadł z indeksu i przestał cokolwiek
 * publikować, zostawał w rejestrze na zawsze i codziennie kosztował fetch.
 *
 * Reguła jest celowo asymetryczna: **degradacja za brak dowodu, śmierć tylko za dowód**.
 * Brak trafienia w wyszukiwarce to słaba przesłanka — dziesięć zapytań z `DISCOVERY_QUERIES`
 * nie jest wyrocznią, a komentarz w `adapters/search.ts` mówi wprost, że małe polskie
 * instytucje bywają indeksowane szczątkowo. Dlatego samo pudło niczego nie wyłącza; dopiero
 * dwa pudła Z RZĘDU przy zerowym plonie w oknie runs.json degradują źródło do `inactive`,
 * skąd wraca automatycznie przy pierwszym trafieniu.
 */
import { isFbFetch } from "../../shared/url.js";
import { todayIso } from "../../shared/dates.js";
import type { RunReport, Source } from "../../types/index.js";

/** Po tylu kolejnych przebiegach bez trafienia źródło bez plonu idzie do `inactive`. */
export const MISS_LIMIT = 2;

export interface ReconcileResult {
  missed: number;
  deactivated: string[];
  reactivated: string[];
}

/**
 * Ile wydarzeń dało źródło w zachowanym oknie runs.json (7 dni — patrz `dailyRunsRetention`,
 * którego komentarz stawia sprawę wprost: okno istnieje po to, żeby dało się odpowiedzieć
 * „od kiedy to źródło zwraca zero"). Plon jest mocniejszą przesłanką niż cokolwiek, co
 * powie wyszukiwarka albo model, więc ma prawo weta wobec degradacji.
 */
export function harvestById(runs: readonly RunReport[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const run of runs) {
    for (const sr of run.sources) out.set(sr.id, (out.get(sr.id) ?? 0) + sr.events);
  }
  return out;
}

/**
 * Czy to źródło w ogóle podlega rozliczeniu w tym przebiegu.
 *
 * Trzy wykluczenia, każde z innego powodu:
 *  - gmina poza zasięgiem przebiegu — nikt tam nie szukał, więc „nie znaleziono" nic nie znaczy;
 *  - źródła FB — `verifySource` pomija je z powodu login-walla, a Google i tak nie indeksuje
 *    grup; degradacja za brak trafienia wykosiłaby żywe grupy;
 *  - `dead` — już rozstrzygnięte mocniejszym dowodem, degradacja niczego nie doda.
 */
const eligible = (src: Source, towns: ReadonlySet<string>): boolean =>
  towns.has(src.town) && !isFbFetch(src.fetch) && !src.dead;

/**
 * Nalicza pudła i degraduje. Woła się PO wszystkich gminach danego przebiegu, bo dopiero
 * wtedy wiadomo, że źródła nie potwierdziła żadna z nich.
 */
export function reconcile(
  sources: readonly Source[],
  ctx: { run: string; towns: readonly string[]; harvest: ReadonlyMap<string, number> },
): ReconcileResult {
  const towns = new Set(ctx.towns);
  const out: ReconcileResult = { missed: 0, deactivated: [], reactivated: [] };

  for (const src of sources) {
    if (!eligible(src, towns)) continue;
    if (src.lastSeenRun === ctx.run) {
      // potwierdzone w tym przebiegu — `confirm()` już wyzerowało licznik i zdjęło `inactive`
      if (src.inactive) out.reactivated.push(src.id);
      continue;
    }

    src.missedRuns = (src.missedRuns ?? 0) + 1;
    out.missed++;
    if (src.inactive || src.missedRuns < MISS_LIMIT) continue;
    if ((ctx.harvest.get(src.id) ?? 0) > 0) continue; // plonuje — brak trafień nas nie obchodzi

    src.inactive = true;
    src.notes = `${src.notes ? src.notes + " | " : ""}${todayIso()}: nieaktywne — ` +
      `${src.missedRuns} przebiegi discovery bez trafienia i zero wydarzeń w oknie runs.json`;
    out.deactivated.push(src.id);
  }
  return out;
}
