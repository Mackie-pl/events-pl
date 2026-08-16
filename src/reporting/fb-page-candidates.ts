/**
 * KTÓRY FANPAGE WARTO W OGÓLE ZMIERZYĆ — dobór kandydatów do sondy `probe-fb-pages`.
 *
 * Fanpage'e (`fetch: "fb"`) leżą w rejestrze pomijane od zawsze, a powód zapisany w kodzie
 * (daily.ts) jest wyłącznie wykonawczy: „inny dataset Bright Data, poza zakresem daily".
 * NIKT nigdy nie sprawdził, czy są zbędne. Ten moduł odpowiada na to pytanie z danych,
 * zanim wydamy choćby jeden rekord: instytucja, której własna strona wypisuje wydarzenia,
 * nie potrzebuje płatnego fanpage'a; instytucja, której strona jest archiwum albo nie
 * istnieje, jest na FB widoczna WYŁĄCZNIE przez fanpage.
 *
 * Trzy kubełki, bo to trzy różne decyzje:
 *   - `covered`    — strona instytucji działa. Nie sondujemy, nie płacimy, koniec tematu.
 *   - `stale-site` — strona istnieje, ale w oknie nie dała (prawie) nic. Sondujemy, bo nie
 *                    da się z zewnątrz odróżnić „instytucja przestała aktualizować stronę"
 *                    od „instytucja nie ma nic w planie" (sierpień, przerwa wakacyjna).
 *   - `no-site`    — w rejestrze nie ma żadnej strony tej instytucji. Fanpage jest jedynym
 *                    kanałem, jaki ta instytucja ma.
 *
 * PAROWANIE JEST HEURYSTYKĄ I MA BYĆ WIDOCZNE. Nazwy w rejestrze pochodzą z discovery,
 * więc „Gminny Ośrodek Kultury w Komornikach" ma się sparować z `gok-komorniki-kalendarz`
 * po nazwie, nie po id. Dopasowanie idzie po PREFIKSACH tokenów (5 znaków), bo polska
 * odmiana rozjeżdża końcówki („Luboniu"/"Luboń", „Kultury"/"Kultura") i porównanie całych
 * słów gubiłoby poprawne pary. Każda decyzja niesie `why` do wydruku — próg, który zdejmuje
 * źródło z listy, musi dać się sprawdzić okiem, a nie tylko uwierzyć.
 *
 * Token gminy jest z parowania WYRZUCANY: w Luboniu wszystko nazywa się „…Luboń", więc
 * bez tego każdy fanpage pasowałby do każdej strony w swojej gminie.
 */
import type { Source } from "../types/index.js";

import type { SourceYield } from "./source-yield.js";

/** Ile wydarzeń w oknie musi dać strona instytucji, żeby uznać fanpage za zbędny. */
export const MIN_PEER_EVENTS = 3;

/** Długość prefiksu tokenu — kompromis między polską odmianą a fałszywymi trafieniami. */
const STEM = 5;

/**
 * Słowa, które nie niosą tożsamości instytucji, tylko rolę strony. „Gmina" i „miejska"
 * świadomie NIE są tutaj: „Gmina Komorniki" po odjęciu gminy i nazwy miejscowości nie ma
 * już ani jednego tokenu, a jej stroną jest `komorniki-pl-kalendarz` („Gmina Komorniki —
 * Kalendarz wydarzeń"). Rzadkość tokenu w gminie liczy się osobno i to ona odsiewa słowa
 * zbyt pospolite, żeby cokolwiek znaczyły.
 */
const STOP = new Set([
  "publi", "wydar", "kalen", "stron", "aktua", "faceb", "fanpa",
  "oficj", "profi", "www", "portal", "serwi", "katal",
]);

/**
 * Wagi dopasowania i próg uznania fanpage'a za zbędny.
 *
 * BŁĄD JEST NIESYMETRYCZNY i to on ustawia te liczby. Fałszywe „covered" znaczy, że
 * goldmine nigdy nie zostanie zmierzony — i nikt się o tym nie dowie, bo źródła po prostu
 * nie ma na liście. Fałszywe „do sondy" kosztuje jedno pobranie (~20 rekordów, ~$0.03)
 * i widać je w tabeli wyników jako źródło bez nowych wydarzeń. Dlatego „covered" wymaga
 * dopasowania MOCNEGO: albo token unikalny w gminie (skrót instytucji: „gok", „posir",
 * „zamek"), albo trzy pospolite. Samo „centrum kultury" nie wystarcza — w Poznaniu pasuje
 * do pięciu różnych instytucji naraz (`cik-poznan-fb` parował się tak z `ck-zamek`).
 */
const RARE_STEM = 3;
const COMMON_STEM = 1;
const COVERED_SCORE = 3;

/** `ł` nie ma formy rozłożonej w NFD — trzeba osobno, inaczej „Luboń" i „lubon" się rozjadą. */
const stripDiacritics = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");

/** Nazwa → zbiór prefiksów tokenów, bez słów pustych i bez tokenów gminy. */
export function stems(text: string, town: string): Set<string> {
  const townStems = new Set(
    stripDiacritics(town.toLowerCase()).split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3).map((w) => w.slice(0, STEM)),
  );
  const out = new Set<string>();
  for (const w of stripDiacritics(text.toLowerCase()).split(/[^a-z0-9]+/)) {
    if (w.length < 3) continue;
    const s = w.slice(0, STEM);
    if (STOP.has(s) || townStems.has(s)) continue;
    out.add(s);
  }
  return out;
}

export type Bucket = "covered" | "stale-site" | "no-site";

export interface FbPageCandidate {
  id: string;
  name: string;
  town: string;
  url: string;
  bucket: Bucket;
  /** strona tej samej instytucji, jeśli znaleziona — nośnik decyzji */
  peer?: { id: string; distinct: number; status: string; shared: string[]; score: number };
  /** zdanie po polsku: dlaczego ten kubełek. Idzie na wydruk i do raportu */
  why: string;
}

interface Peer {
  id: string;
  name: string;
  town: string;
  distinct: number;
  status: string;
}

/** Strony (nie-FB) z plonem w oknie — kandydaci na „własną stronę instytucji". */
function webPeers(sources: readonly Source[], rows: readonly SourceYield[]): Peer[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Peer[] = [];
  for (const s of sources) {
    if (s.fetch === "fb" || s.fetch === "fb_group" || s.fetch === "fb_event") continue;
    const row = byId.get(s.id);
    out.push({
      id: s.id,
      name: `${s.name} ${s.id}`, // id niesie skróty ("gok", "losir"), których nie ma w nazwie
      town: s.town,
      distinct: row?.distinct ?? 0,
      status: row?.status ?? "nieznany",
    });
  }
  return out;
}

/** Ile stron w gminie niesie dany rdzeń — nośnik „rzadkości", czyli siły dopasowania. */
function stemFrequency(peers: readonly Peer[], town: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const p of peers) {
    if (p.town !== town) continue;
    for (const s of stems(p.name, p.town)) freq.set(s, (freq.get(s) ?? 0) + 1);
  }
  return freq;
}

interface Match { peer: Peer; shared: string[]; score: number }

/**
 * Najlepsza para dla fanpage'a. Przy REMISIE wygrywa strona o NIŻSZYM plonie — odwrotnie,
 * niż podpowiada odruch. Remis znaczy „nie wiadomo, która to instytucja", a wtedy jedyna
 * bezpieczna odpowiedź to zmierzyć: wybór strony plennej zamykałby temat werdyktem
 * „covered" na podstawie zgadywanki. Tak właśnie `biblioteka-puszczykowo-fb` parowało się
 * z kalendarzem miasta (22 wydarzenia) zamiast z własnym, martwym katalogiem biblioteki.
 */
function bestPeer(page: Source, peers: readonly Peer[]): Match | null {
  const mine = stems(`${page.name} ${page.id}`, page.town);
  const freq = stemFrequency(peers, page.town);
  let best: Match | null = null;
  for (const p of peers) {
    if (p.town !== page.town) continue;
    const theirs = stems(p.name, p.town);
    const shared = [...mine].filter((s) => theirs.has(s));
    if (!shared.length) continue;
    const score = shared.reduce(
      (n, s) => n + ((freq.get(s) ?? 0) <= 1 ? RARE_STEM : COMMON_STEM), 0,
    );
    const better = !best
      || score > best.score
      || (score === best.score && p.distinct < best.peer.distinct);
    if (better) best = { peer: p, shared, score };
  }
  return best;
}

function verdict(page: Source, match: Match | null): FbPageCandidate {
  const base = { id: page.id, name: page.name, town: page.town, url: page.url };
  if (!match || match.score < COVERED_SCORE) {
    const weak = match
      ? ` (najbliższa, ${match.peer.id}, dzieli tylko „${match.shared.join(", ")}" `
        + `— za słabo, żeby uznać za tę samą instytucję)`
      : "";
    return {
      ...base, ...(match ? { peer: peerInfo(match) } : {}), bucket: "no-site",
      why: `w rejestrze nie ma strony tej instytucji${weak} — fanpage jest jej jedynym kanałem`,
    };
  }
  const { peer } = match;
  if (peer.distinct >= MIN_PEER_EVENTS) {
    return {
      ...base, bucket: "covered", peer: peerInfo(match),
      why: `strona ${peer.id} dała ${peer.distinct} wydarzeń w oknie — fanpage nic nie dokłada`,
    };
  }
  return {
    ...base, bucket: "stale-site", peer: peerInfo(match),
    why: `strona ${peer.id} istnieje, ale dała ${peer.distinct} wydarzeń `
      + `(status „${peer.status}") — nie wiadomo, czy instytucja milczy, czy tylko strona`,
  };
}

const peerInfo = (m: Match): NonNullable<FbPageCandidate["peer"]> =>
  ({ id: m.peer.id, distinct: m.peer.distinct, status: m.peer.status, shared: m.shared, score: m.score });

/**
 * Klasyfikacja wszystkich fanpage'ów z rejestru. Kolejność wyniku: najpierw do sondowania
 * (`no-site`, potem `stale-site`), na końcu `covered` — żeby wydruk zaczynał się od tego,
 * o co pytamy.
 */
export function classifyFbPages(
  sources: readonly Source[], rows: readonly SourceYield[],
): FbPageCandidate[] {
  const peers = webPeers(sources, rows);
  const order: Record<Bucket, number> = { "no-site": 0, "stale-site": 1, covered: 2 };
  return sources
    .filter((s) => s.fetch === "fb")
    .map((s) => verdict(s, bestPeer(s, peers)))
    .sort((a, b) => order[a.bucket] - order[b.bucket] || a.town.localeCompare(b.town));
}

/** Kandydaci do zapłacenia: wszystko poza `covered`. */
export const toProbe = (all: readonly FbPageCandidate[]): FbPageCandidate[] =>
  all.filter((c) => c.bucket !== "covered");
