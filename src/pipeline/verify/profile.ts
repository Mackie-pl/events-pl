/**
 * Profilowanie źródła: gdzie wchodzić i co serwis oddaje maszynowo.
 *
 * Wydzielone z `verifySource`, które było już orkiestratorem ponad progiem złożoności
 * (patrz eslint.shared.js), a miało dostać cztery kolejne kroki. Podział przebiega tam,
 * gdzie zmienia się pytanie: `verify-source.ts` odpowiada „czy ten adres żyje i czym go
 * pobrać", ten plik — „co pod nim jest".
 */
import { BROWSER_HEADERS, fetchUrl } from "../../adapters/http.js";
import { probeCapabilities } from "../discover/capabilities.js";
import { resolveEntrypoints } from "../discover/entrypoint.js";
import { auditionEntrypoints } from "../discover/entrypoint-audition.js";
import { carryBarrenRuns } from "../discover/entrypoint-yield.js";
import type { EntryPoint, Source, SourceCapability } from "../../types/index.js";

import { countFetch } from "./probe.js";

export interface SourceProfile {
  entrypoints: EntryPoint[];
  capabilities: SourceCapability[];
  verdict?: "events" | "news" | "none";
  why?: string;
  /** adresy odrzucone próbną ekstrakcją — bez tego odsiew byłby niewidoczny w raporcie */
  rejectedEntrypoints?: Array<{ url: string; why: string }>;
}

/** Surowy HTML korzenia — profiler potrzebuje odnośników, więc nie może iść przez html-to-text. */
async function rootHtml(url: string): Promise<string | null> {
  try {
    countFetch();
    const res = await fetchUrl(url, { headers: BROWSER_HEADERS }, 20_000);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Źródła, które z definicji nie mają HTML-owej listy wydarzeń — pytanie o entrypoint jest
 * dla nich bez sensu, a odpowiedź zawsze brzmi „nie widzę tu wydarzeń".
 *
 * Nauczka z pierwszego przebiegu: `poznan-city-api` to SOAP WSDL. Model obejrzał XML-a ze
 * schematem usługi, słusznie orzekł `verdict:"none"` — i źródło poszło do kosza, mimo że
 * jest w pełni sprawnym wejściem, tylko maszynowym.
 */
const NO_HTML_LISTING: ReadonlySet<string> = new Set(["api", "rss", "pdf", "pdf_program"]);

const skipsEntrypoints = (src: Source): boolean =>
  NO_HTML_LISTING.has(src.fetch) || NO_HTML_LISTING.has(src.type);

/**
 * Pełny profil źródła pod potwierdzonym już adresem.
 *
 * Zdolności sondujemy PO entrypointach, bo iCal i JSON-LD mają sens dopiero na stronie listy —
 * na korzeniu serwisu obu zwykle nie ma, nawet gdy serwis je udostępnia.
 */
export async function profileSource(src: Source, url: string): Promise<SourceProfile> {
  const html = await rootHtml(url);
  if (html === null) return { entrypoints: [], capabilities: [] };
  if (skipsEntrypoints(src)) {
    // sam feed/API JEST entrypointem — sondujemy tylko zdolności, bez modelu
    return { entrypoints: [], capabilities: await probeCapabilities(url, html) };
  }

  const resolved = await resolveEntrypoints(src, url, html);
  // adres, którego model nie potwierdził, przechodzi próbną ekstrakcję ZANIM wejdzie do
  // rejestru — inaczej `daily` płaci za niego co dzień, żeby co dzień dostać zero
  const { entrypoints, rejected } = await auditionEntrypoints(resolved.entrypoints);
  const entry = entrypoints[0]?.url;
  const capabilities = await probeCapabilities(url, html, entry);

  return {
    entrypoints, capabilities,
    ...(rejected.length ? { rejectedEntrypoints: rejected } : {}),
    ...(resolved.verdict ? { verdict: resolved.verdict } : {}),
    ...(resolved.why ? { why: resolved.why } : {}),
  };
}

/**
 * Zapis profilu na źródle. Nadpisuje w całości, nie scala: profil opisuje stan serwisu
 * w chwili sprawdzenia, a doklejanie do starej listy zostawiłoby w rejestrze entrypointy
 * z nieistniejących już działów.
 */
export function applyProfile(src: Source, profile: SourceProfile): void {
  // licznik jałowych przebiegów przeżywa nadpisanie: to wiedza o ADRESIE zbierana miesiącami,
  // a nie część opisu serwisu, więc zerowanie jej co przebieg unieważniałoby próg
  if (profile.entrypoints.length) src.entrypoints = carryBarrenRuns(profile.entrypoints, src.entrypoints);
  else delete src.entrypoints;
  if (profile.capabilities.length) src.capabilities = profile.capabilities;
  else delete src.capabilities;
}
