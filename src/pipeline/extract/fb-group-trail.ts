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
import type { FbPostExtras, FbShareStats } from "../facebook.js";

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
/**
 * Z czego składa się różnica `records − posts`.
 *
 * Bez tego zdania „5 postów z 5 rekordów" nie odpowiada na pytanie, czemu wczoraj to samo
 * źródło pokazywało 2 — a to jest pierwsze, które ktoś zada, patrząc na skok po zmianie
 * definicji postu (2026-08-20: udostępnienie bez podpisu i post z samym plakatem przestały
 * uchodzić za wiersze błędu scrapera).
 */
function shapeNote(s: FbGroupStats): string {
  return [
    s.sharedOnly ? `${s.sharedOnly} bez podpisu (treść z udostępnionego oryginału)` : null,
    s.imageOnly ? `${s.imageOnly} z samym plakatem, bez tekstu` : null,
    s.errorRows ? `${s.errorRows} wierszy błędu scrapera` : null,
  ].filter(Boolean).join(", ");
}

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
  const shape = shapeNote(s);
  const rate = s.postsPerDay === undefined
    ? `wszystko z jednej chwili — tempa nie da się policzyć, wiadomo tylko ≥${s.posts}/dobę`
    // okno krótsze od doby trafia w godziny szczytu i zawyża tempo (noc nic nie publikuje) —
    // limit policzony z takiej próbki byłby za wysoki, czyli droższy
    : `${s.postsPerDay} postów/dobę${(s.spanDays ?? 0) < 1 ? " (okno < doby — zawyżone)" : ""}`;
  audit("fb.group",
    `${s.posts} postów z ${s.records} płatnych rekordów${shape ? ` (w tym ${shape})` : ""} · `
    + `najnowszy ${s.newest}, najstarszy ${s.oldest} (okno ${s.spanDays} dni) → ${rate} · `
    + (s.atLimit
      ? `limit ${s.limit} wyczerpany, więc to DOLNA granica tempa`
      : `limit ${s.limit} niewyczerpany, więc okno to cała dostępna grupa`),
    {
      posts: s.posts, records: s.records, sharedOnly: s.sharedOnly, imageOnly: s.imageOnly,
      errorRows: s.errorRows, newest: s.newest ?? null, oldest: s.oldest ?? null,
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

/**
 * Ile treści udostępnień było kopią samej siebie.
 *
 * Osobno od `auditFbOrigins`, bo odpowiada na inne pytanie: tamten krok mówi, ILE postów jest
 * udostępnieniami, ten — ile z nich mówiło to samo dwa razy i ilu znaków nie wysłaliśmy.
 * Liczba ma pilnować progu, przy którym odsiew zaczyna być podejrzany: `onlyCaption` rosnące
 * ponad pojedyncze przypadki znaczyłoby, że wycinamy oryginały, a to strona z ogłoszeniem.
 */
export function auditFbShares(x: FbShareStats): void {
  if (!x.shares) return;
  const cut = x.onlyOriginal + x.onlyCaption;
  audit("fb.group", cut
    ? `${cut} z ${x.shares} udostępnień powtarzało własną treść (podpis = wklejone ogłoszenie) — `
      + `do modelu raz, ${x.charsSaved} znaków mniej`
    : `${x.shares} udostępnień, każde z własnym podpisem — nie ma czego skracać`,
  { shares: x.shares, both: x.both, onlyOriginal: x.onlyOriginal, onlyCaption: x.onlyCaption,
    charsSaved: x.charsSaved });
}

export function auditFbPostExtras(x: FbPostExtras, posts: number): void {
  if (!posts) return; // sama porażka scrapera — auditFbGroup już to powiedział
  const place = x.placeField
    ? ` · ${x.withPlace} z miejscem w polu „${x.placeField}", pomijanym`
    : "";
  audit("fb.group",
    x.imageField
      ? `${x.withImage} z ${posts} postów ma obraz (pole „${x.imageField}") — idą do odczytu `
        + `plakatów${place}`
      : `żaden z ${posts} postów nie oddał obrazu w znanych polach — nie ma czego czytać${place}`,
    {
      withImage: x.withImage, imageField: x.imageField, posts,
      withPlace: x.withPlace, placeField: x.placeField, sampleImage: x.sampleImage,
    });
  auditFbAuthors(x, posts);
}

/**
 * Czy „ten sam gość dziesiąty raz w tym miesiącu" to w naszych grupach realne zjawisko.
 *
 * Pomysł na reputację autora (ignorujemy sprzedawcę borówek, tak jak w realnym życiu) jest
 * sensowny, ale zanim powstanie mechanizm, trzeba wiedzieć dwie rzeczy, których dziś NIE wiemy:
 * czy dataset w ogóle oddaje autora i czy powtarzalność jest na tyle skupiona, żeby cokolwiek
 * dała. Stąd ten krok — mierzy, niczego nie blokuje.
 *
 * W ŚLADZIE LĄDUJĄ WYŁĄCZNIE LICZNIKI I NAZWA POLA. Żadnej wartości identyfikującej: repo jest
 * publiczne, `audit.json` commitowany, a autor postu w wiejskiej grupie to osoba prywatna.
 * Na pytanie „czy ktoś wrzuca dziesięć ogłoszeń" odpowiada liczba, nie nazwisko.
 *
 * Uwaga przy czytaniu wyniku: okno grupy to zwykle jedna–dwie doby (patrz `FbGroupStats`),
 * więc `maxPostsByAuthor` mierzy skupienie W OKNIE, a nie „w miesiącu". Wzorzec rozłożony
 * na tygodnie zobaczymy dopiero po kilku przebiegach, składając te liczby z kolejnych dni.
 */
function auditFbAuthors(x: FbPostExtras, posts: number): void {
  if (!x.authorField) {
    audit("fb.group",
      `dataset nie oddaje autora postu w żadnym ze znanych pól — reputacja autora nieosiągalna`,
      { authorField: null, posts });
    return;
  }
  audit("fb.group",
    `${x.authors} różnych autorów na ${posts} postów (pole „${x.authorField}"), `
    + `${x.repeatAuthors} napisało więcej niż raz, rekordzista ${x.maxPostsByAuthor}`,
    {
      authorField: x.authorField, authors: x.authors, posts,
      repeatAuthors: x.repeatAuthors, maxPostsByAuthor: x.maxPostsByAuthor,
    });
}
