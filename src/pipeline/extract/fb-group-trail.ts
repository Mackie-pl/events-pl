/**
 * Ślad grupy FB: co dostaliśmy za opłacone rekordy i czego z tego potok NIE używa.
 *
 * Osobno od process-source.ts, bo to dwie różne role. Tam jest przepływ źródła, tu wyłącznie
 * zapis pomiarów — a oba kroki niżej mają wspólną cechę, która trzyma je razem: żaden nie
 * podejmuje decyzji. Zapisują liczby, na których decyzja (limit rekordów per grupa, czytanie
 * plakatów) ma się dopiero oprzeć — i dopóki jej nie ma, ślad jest jedynym miejscem, gdzie te
 * liczby w ogóle istnieją. Sąsiedzi po tej samej stronie: fb-group-limit.ts, fb-group-blocked.ts.
 */
import { audit } from "../../shared/audit.js";
import type { FbGroupStats } from "../../types/index.js";
import type { FbPostExtras } from "../facebook.js";

/**
 * Ślad rytmu publikacji grupy.
 *
 * Ten krok NIE rusza jeszcze limitu — zapisuje liczby, na których decyzja o limicie liczonym
 * per grupa ma się dopiero oprzeć. Po drodze rozstrzyga rzecz nieudokumentowaną u dostawcy:
 * czy `limit_per_input` oddaje NAJNOWSZE posty, czy dowolne. Świeży `newest` przy nasyconym
 * limicie znaczy „najnowsze"; `newest` sprzed tygodni znaczy „dowolne" — a wtedy tempo
 * policzone z tego okna jest bez wartości i cały pomysł trzeba porzucić, zanim zacznie
 * sterować wydatkiem.
 */
export function auditFbGroup(s: FbGroupStats, archive?: string | null): void {
  // ścieżka surowej migawki idzie do OBU wariantów, ale najbardziej potrzebna jest w tym
  // pierwszym: „zero postów za N płatnych rekordów" to zdanie, po którym pierwsze pytanie
  // brzmi „to co on w takim razie oddał", a odpowiedzi nie ma nigdzie poza tym plikiem
  const where = archive ? { archive } : {};
  if (!s.posts) {
    audit("fb.group",
      `${s.records} płatnych rekordów, ani jednego postu — same wiersze błędu scrapera`,
      { records: s.records, errorRows: s.errorRows, why: s.blockedWhy ?? null, ...where });
    return;
  }
  const rate = s.postsPerDay === undefined
    ? `wszystko z jednej chwili — tempa nie da się policzyć, wiadomo tylko ≥${s.posts}/dobę`
    // okno krótsze od doby trafia w godziny szczytu i zawyża tempo (noc nic nie publikuje) —
    // limit policzony z takiej próbki byłby za wysoki, czyli droższy
    : `${s.postsPerDay} postów/dobę${(s.spanDays ?? 0) < 1 ? " (okno < doby — zawyżone)" : ""}`;
  audit("fb.group",
    `${s.posts} postów z ${s.records} płatnych rekordów · najnowszy ${s.newest}, najstarszy ${s.oldest} `
    + `(okno ${s.spanDays} dni) → ${rate} · `
    + (s.atLimit
      ? `limit ${s.limit} wyczerpany, więc to DOLNA granica tempa`
      : `limit ${s.limit} niewyczerpany, więc okno to cała dostępna grupa`),
    {
      posts: s.posts, records: s.records, newest: s.newest ?? null, oldest: s.oldest ?? null,
      spanDays: s.spanDays ?? null, postsPerDay: s.postsPerDay ?? null, atLimit: s.atLimit,
      ...where,
    });
}

/**
 * Ile z opłaconej treści postu NIE dochodzi do modelu.
 *
 * Spłaszczanie bierze samą treść, więc plakat i ewentualne miejsce z rekordu przepadają —
 * a u ogłoszeń z grup „gdzie" stoi często wyłącznie na obrazku („W podwodnym świecie",
 * 2026-08-12: wydarzenie w digeście z pustym `venue`). Ślad ma odpowiedzieć na dwa pytania,
 * których dziś nie da się zadać danym: KTÓRE pole datasetu niesie obraz i W ILU postach.
 * Dopóki nie znamy odpowiedzi, czytanie plakatów byłoby wydatkiem w nieznanej skali.
 */
/**
 * Ile postów źródła to udostępnienia cudzych ogłoszeń.
 *
 * Osobny krok, bo od tej liczby zależą dwie rzeczy naraz: ile treści doszło do promptu
 * (oryginał jest doklejany, nie podstawiany — patrz fbGroupPostsToText) i ile wydarzeń ma
 * szansę zescalić się z innej grupy po `origin.key`, bez modelu. Grupa, w której udostępnień
 * jest zero, nie skorzysta z żadnego z tych dwóch — i to widać dopiero tutaj.
 */
export function auditFbOrigins(shares: number, posts: number): void {
  if (!posts) return;
  audit("fb.group", shares
    ? `${shares} z ${posts} postów to udostępnienia — treść oryginału idzie do modelu, `
      + "a jego id wiąże ten sam wpis między grupami"
    : `żaden z ${posts} postów nie jest udostępnieniem — nie ma oryginału do doczytania`,
  { shares, posts });
}

export function auditFbPostExtras(x: FbPostExtras, posts: number): void {
  if (!posts) return; // sama porażka scrapera — auditFbGroup już to powiedział
  const place = x.placeField
    ? ` · ${x.withPlace} z miejscem w polu „${x.placeField}", też pomijanym`
    : "";
  audit("fb.group",
    x.imageField
      ? `${x.withImage} z ${posts} postów ma obraz (pole „${x.imageField}") — plakaty NIEczytane, `
        + `do modelu idzie sam tekst postu${place}`
      : `żaden z ${posts} postów nie oddał obrazu w znanych polach — nie ma czego czytać${place}`,
    {
      withImage: x.withImage, imageField: x.imageField, posts,
      withPlace: x.withPlace, placeField: x.placeField, sampleImage: x.sampleImage,
    });
}
