/**
 * Drabina osiągalności: czy pod tym adresem cokolwiek żyje i CO trzeba zrobić, żeby to pobrać.
 *
 * Poprzednia wersja miała jedną sondę i jednego boola, przez co trzy zupełnie różne diagnozy
 * wyglądały identycznie. Pomiar na rejestrze z lipca 2026 (13 „zepsutych" źródeł):
 *
 *   kok.kornik.pl        certyfikat wygasł   → serwis ŻYJE, http:// odpowiada
 *   www.suchylas.pl      HTTP 403            → serwis ŻYJE, to anty-bot; wystarczy przeglądarka
 *   goksokol.pl i 5 in.  ENOTFOUND           → domena naprawdę nie istnieje
 *
 * Pierwsze dwa naprawia ta drabina, bez wyszukiwarki i bez modelu. Trzeci jest nienaprawialny
 * i — to jest sedno — daje się rozpoznać BEZ wyszukiwarki, więc `dead` przestaje zależeć od
 * tego, czy mamy klucz API.
 */
import { fetchHeadless } from "../../adapters/page-fetch.js";
import type { FetchProbe, FetchStrategy, ReachOutcome } from "../../types/index.js";

import { probeUrl } from "./probe.js";

export interface ReachStep {
  url: string;
  outcome: ReachOutcome;
  httpStatus?: number;
  err?: string;
}

export interface Reachability {
  outcome: ReachOutcome;
  /** adres, pod którym faktycznie coś odpowiedziało (może różnić się od pytanego) */
  url: string;
  /** strategia pobierania potwierdzona doświadczalnie */
  fetch: FetchStrategy;
  probe: FetchProbe;
  /** wszystkie szczeble, także nieudane — bez nich nie widać, czego próbowaliśmy */
  ladder: ReachStep[];
}

/** Błędy sieciowe, po których nie ma sensu próbować dalej TEGO hosta. */
const DNS_DEAD = /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i;
const CERT = /certificate|CERT_|SSL|TLS|ERR_TLS/i;

/** Objawy rozpoznawane po treści błędu, w kolejności rozstrzygania. */
const SYMPTOMS: ReadonlyArray<[RegExp, ReachOutcome]> = [
  [DNS_DEAD, "dns-dead"],
  [CERT, "cert"],
  [/podejrzanie krótka/, "placeholder"],
];

/** Klasyfikacja pojedynczej odpowiedzi. Sam kod statusu nie wystarcza — patrz `probeUrl`. */
export function classify(probe: FetchProbe): ReachOutcome {
  if (probe.ok) return probe.finalUrl ? "redirected" : "ok";
  const status = probe.httpStatus;
  if (status === 403 || status === 429) return "anti-bot";
  if (typeof status === "number" && status >= 400) return "http-error";
  const err = probe.err ?? "";
  return SYMPTOMS.find(([re]) => re.test(err))?.[1] ?? "http-error";
}

/** Warianty adresu do wypróbowania: inny schemat, z/bez `www.`. Kolejność = malejące prawdopodobieństwo. */
export function variants(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  const push = (mutate: (x: URL) => void): void => {
    const v = new URL(u.toString());
    mutate(v);
    // porównanie DOSŁOWNE, nie przez urlKey: urlKey celowo skleja `www.x` z `x` (dla dedupe
    // rejestru to jedno źródło), ale tutaj są to dwa różne adresy do wypróbowania — użycie
    // urlKey kasowało oba warianty z www i drabina traciła połowę szczebli
    const candidate = v.toString();
    if (candidate !== u.toString() && !out.includes(candidate)) out.push(candidate);
  };
  // schemat najpierw: wygasły certyfikat to najczęstsza usterka, którą da się obejść adresem
  push((v) => { v.protocol = u.protocol === "https:" ? "http:" : "https:"; });
  push((v) => { v.host = u.host.startsWith("www.") ? u.host.slice(4) : `www.${u.host}`; });
  push((v) => {
    v.protocol = u.protocol === "https:" ? "http:" : "https:";
    v.host = u.host.startsWith("www.") ? u.host.slice(4) : `www.${u.host}`;
  });
  return out;
}

/** Czy po takim wyniku warto próbować innego wariantu adresu. */
const worthRetrying = (o: ReachOutcome): boolean =>
  o === "cert" || o === "http-error" || o === "placeholder" || o === "dns-dead";

/**
 * Werdykt dla całej drabiny, gdy żaden szczebel nie zadziałał.
 *
 * Kolejność nie jest dowolna: `dns-dead` wymaga, żeby WSZYSTKIE warianty się nie rozwiązały —
 * bo część serwisów ma rekord tylko dla `www.` albo tylko dla gołej domeny, a wystarczy jedna
 * żywa nazwa, żeby domena nie była martwa. Pozostałe objawy idą od najbardziej „naprawialnego":
 * anty-bot i certyfikat mówią, że serwer ISTNIEJE, więc `dead` byłoby fałszywe.
 */
function summarize(ladder: readonly ReachStep[]): ReachOutcome {
  const seen = new Set(ladder.map((s) => s.outcome));
  if (seen.size && [...seen].every((o) => o === "dns-dead")) return "dns-dead";
  return (["anti-bot", "cert", "placeholder"] as const).find((o) => seen.has(o)) ?? "http-error";
}

/**
 * Sprawdza adres, schodząc po wariantach, a na 403/429 sięgając po przeglądarkę.
 *
 * `dns-dead` na pierwszym adresie NIE kończy sprawy: część serwisów ma rekord tylko dla
 * `www.` albo tylko dla gołej domeny, więc warianty i tak przechodzimy — dopiero gdy
 * WSZYSTKIE nie rozwiążą się w DNS, domena jest naprawdę martwa.
 */
/** Jeden szczebel: sonda, zapis do śladu i — przy anty-bocie — próba przez przeglądarkę. */
async function attempt(
  candidate: string, want: FetchStrategy, ladder: ReachStep[],
): Promise<Reachability | null> {
  const probe = await probeUrl(candidate);
  const outcome = classify(probe);
  ladder.push({
    url: candidate, outcome,
    ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}),
    ...(probe.err ? { err: probe.err } : {}),
  });
  if (outcome === "ok" || outcome === "redirected") {
    return { outcome, url: probe.finalUrl ?? candidate, fetch: want, probe, ladder };
  }
  if (outcome !== "anti-bot") return null;

  // WAF odsiewa nagłówki bota, nie nas — treść jest, trzeba tylko prawdziwej przeglądarki
  const viaBrowser = await tryHeadless(candidate);
  if (!viaBrowser) return null;
  ladder.push({ url: candidate, outcome: "ok" });
  return { outcome: "anti-bot", url: candidate, fetch: "headless", probe: viaBrowser, ladder };
}

export async function probeReachable(url: string, want: FetchStrategy = "plain"): Promise<Reachability> {
  const ladder: ReachStep[] = [];
  const first = await attempt(url, want, ladder);
  if (first) return first;

  if (worthRetrying(ladder[0]?.outcome ?? "http-error")) {
    for (const candidate of variants(url)) {
      const hit = await attempt(candidate, want, ladder);
      if (hit) return { ...hit, outcome: "redirected" };
    }
  }

  return {
    outcome: summarize(ladder), url, fetch: want, ladder,
    // sondę powtarzamy dla pierwotnego adresu: raport ma pokazywać, co odpowiedziało TO,
    // o co pytaliśmy, a nie ostatni wariant z drabiny
    probe: (await probeUrl(url).catch(() => null)) ?? failedProbe(url, ladder),
  };
}

const failedProbe = (url: string, ladder: readonly ReachStep[]): FetchProbe => ({
  at: new Date().toISOString(), url, ok: false, ms: 0, err: ladder[0]?.err ?? "brak odpowiedzi",
});

/** Jedna próba przez przeglądarkę. Brak playwrighta (optionalDependency) to nie błąd źródła. */
async function tryHeadless(url: string): Promise<FetchProbe | null> {
  const t0 = performance.now();
  try {
    const got = await fetchHeadless(url);
    if (!got.text.trim()) return null;
    return {
      at: new Date().toISOString(), url, ok: true, httpStatus: got.httpStatus,
      chars: got.text.length, ms: Math.round(performance.now() - t0),
    };
  } catch {
    return null;
  }
}
