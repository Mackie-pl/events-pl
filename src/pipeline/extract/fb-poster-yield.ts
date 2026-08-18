/**
 * Ile naprawdę traci potok, nie czytając plakatów z grup FB.
 *
 * Osobno od `fb-group-trail.ts`, bo to pomiar innego rodzaju: tamte liczby biorą się
 * z SAMYCH rekordów Bright Data i są gotowe zaraz po pobraniu, a ten zestawia post
 * z tym, co model z niego wyciągnął — czyli powstaje dopiero na końcu przetwarzania
 * źródła, po ekstrakcji, cache'u bloków i followupach.
 *
 * Dlaczego w ogóle: `FbPostExtras` policzył 157 z 257 postów z obrazem (2026-08-17),
 * co wyglądało na wielką dziurę — dopóki cztery z tych obrazów nie zostały obejrzane.
 * Były to zdjęcie remontu, borówki, róża ze stocka i grill. `withImage` mierzy ZAŁĄCZNIK,
 * a pytanie brzmi „czy na tym załączniku stoi treść, której nie ma w tekście postu".
 * Odpowiada na nie dopiero różnica między postami z obrazem i bez.
 *
 * Ten moduł NIE podejmuje decyzji i niczego nie kupuje — zapisuje liczby, na których
 * decyzja o wywołaniach wizyjnych ma się dopiero oprzeć.
 */
import { audit } from "../../shared/audit.js";
import { urlKey } from "../../shared/url.js";
import type { EventItem, FbPosterBucket, FbPosterYield } from "../../types/index.js";

const emptyBucket = (): FbPosterBucket =>
  ({ posts: 0, yielded: 0, events: 0, noVenue: 0, noTime: 0 });

/**
 * Posty grupy zestawione z wydarzeniami, które z nich wyszły.
 *
 * `imagePosts` to mapa z `fbImagePosts` (klucz `urlKey` adresu postu → liczba obrazów);
 * jest w niej KAŻDY post z treścią, także ten z zerem obrazów — inaczej koszyk odniesienia
 * nie miałby z czego powstać.
 *
 * Wiązanie idzie przez `urlKey(source_url)`, tą samą drogą co `origin` w process-source.ts,
 * i tak samo potrafi nie zajść: model przepisuje „LINK:" z bloku i bywa, że gubi `www.`.
 * Takie wydarzenia idą do `unlinked` zamiast do któregoś koszyka — wrzucone na chybił trafił
 * przesuwałyby dokładnie tę proporcję, dla której ten pomiar istnieje.
 */
export function fbPosterYield(
  imagePosts: Map<string, number>, events: EventItem[],
): FbPosterYield {
  const out: FbPosterYield = {
    withImage: emptyBucket(), withoutImage: emptyBucket(), unlinked: 0,
  };
  const yielded = new Set<string>();

  for (const images of imagePosts.values()) {
    (images > 0 ? out.withImage : out.withoutImage).posts += 1;
  }

  for (const ev of events) {
    const key = urlKey(ev.source_url ?? "");
    const images = imagePosts.get(key);
    if (images === undefined) { out.unlinked += 1; continue; }
    const bucket = images > 0 ? out.withImage : out.withoutImage;
    bucket.events += 1;
    if (!yielded.has(key)) { yielded.add(key); bucket.yielded += 1; }
    // "" a nie null: pola czysto tekstowe mają w schemacie pusty string (patrz orEmpty())
    if (!ev.venue) bucket.noVenue += 1;
    if (!ev.time_start) bucket.noTime += 1;
  }
  return out;
}

/** Udział w procentach, `—` gdy mianownik zerowy (zamiast NaN, które nic nie znaczy). */
const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : "—");

/**
 * Ślad pomiaru: dwa koszyki obok siebie, bo pojedyncza liczba z koszyka „z obrazem"
 * nie znaczy nic. „Połowa wydarzeń bez miejsca" jest ciekawa dopiero wtedy, gdy po
 * drugiej stronie stoi „a bez obrazu jedna piąta" — inaczej mierzy zwyczaje piszących
 * na FB, a nie wartość plakatu.
 *
 * Milczące posty (`posts - yielded`) są tu najważniejszą liczbą, mimo że to właśnie
 * o nich wiemy najmniej: post, którego całą treścią jest obraz z jednym słowem podpisu,
 * daje dziś zero wydarzeń i wygląda identycznie jak ogłoszenie o sprzedaży roweru.
 */
export function auditFbPosterYield(y: FbPosterYield): void {
  const wi = y.withImage;
  const wo = y.withoutImage;
  if (!wi.posts && !wo.posts) return; // nie grupa albo pobranie padło — auditFbGroup już to powiedział
  const silent = (b: FbPosterBucket): string => `${b.posts - b.yielded} z ${b.posts} milczy`;
  audit("fb.group",
    `plakaty — z obrazem: ${silent(wi)}, ${wi.events} wydarzeń, `
    + `bez miejsca ${pct(wi.noVenue, wi.events)}, bez godziny ${pct(wi.noTime, wi.events)} · `
    + `bez obrazu: ${silent(wo)}, ${wo.events} wydarzeń, `
    + `bez miejsca ${pct(wo.noVenue, wo.events)}, bez godziny ${pct(wo.noTime, wo.events)}`,
    // detal jest płaski, bo AuditDetail przyjmuje wyłącznie wartości proste — a te liczby
    // mają się dać czytać z panelu bez rozpakowywania zagnieżdżeń
    {
      imgPosts: wi.posts, imgSilent: wi.posts - wi.yielded, imgEvents: wi.events,
      imgNoVenue: wi.noVenue, imgNoTime: wi.noTime,
      txtPosts: wo.posts, txtSilent: wo.posts - wo.yielded, txtEvents: wo.events,
      txtNoVenue: wo.noVenue, txtNoTime: wo.noTime,
      unlinked: y.unlinked,
    });
}
