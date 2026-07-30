/**
 * Prompty dla obu etapów pipeline'u.
 *
 * Blok schematu wydarzenia NIE jest tu pisany ręcznie — renderuje go renderSchemaBlock()
 * z types/event-schema.ts. Wcześniej ten sam kształt istniał w trzech miejscach naraz
 * (typ, prompt ekstrakcji, prompt plakatu) i się rozjeżdżał: POSTER_SYSTEM kazał modelowi
 * trzymać się „tego samego schematu JSON", którego w ogóle nie miał w kontekście.
 *
 * Reguły MIĘDZYpolowe (kontenery, followupy, „bez daty = nie wydarzenie") zostają prozą.
 * Schemat opisuje kształt jednego rekordu i tego się trzyma; wciskanie w niego reguł
 * przekrojowych skończyłoby się opisami pól, których model nie ma jak zastosować.
 */
import { renderSchemaBlock } from "../shared/json-schema.js";
import { EventSchema } from "../types/event-schema.js";

const EVENT_BLOCK = renderSchemaBlock(EventSchema);

// ============ STAGE 1: discovery (raz w miesiącu, mocny model) ============

export const DISCOVERY_SYSTEM = `Jesteś asystentem budującym rejestr źródeł lokalnych wydarzeń w Polsce.
Dostajesz wyniki wyszukiwania dla miasta/gminy. Wybierz strony, które PUBLIKUJĄ wydarzenia:
- portale urzędów miast/gmin (kalendarze, aktualności)
- ośrodki/domy kultury (uwaga: duże miasta mają DK w każdej dzielnicy — szukaj wszystkich)
- biblioteki, OSiR-y, muzea, teatry, galerie
- publiczne strony/fanpage FB instytucji i miejsc (plaże miejskie, parki, kawiarnie z eventami)
- OTWARTE grupy FB o życiu lokalnym ("Co słychać w …", "Wydarzenia …", "Mamy z …",
  "Ogłoszenia …") — mieszkańcy wrzucają tam plakaty i wydarzenia. Tylko publiczne/otwarte grupy.
Odrzuć: agregatory biletowe, katalogi firm, strony martwe/archiwalne, grupy zamknięte/kupię-sprzedam/prywatne.
Rozpoznawanie FB po URL:
- facebook.com/groups/<...>  → fetch:"fb_group", type:"fb_group"; URL skróć do korzenia grupy
  (https://www.facebook.com/groups/<id-lub-slug>, bez /posts/… ani parametrów)
- facebook.com/<fanpage>      → fetch:"fb", type:"fb_page"
Zwróć JSON: {"sources":[{"id","name","type","url","town","fetch":"plain|headless|pdf|api|fb|fb_group","confidence":0-1,"why","notes"}]}
Typy: city_portal, culture_center, library, sports, venue, fb_page, fb_group, rss, api, pdf_program.
"why": JEDNO zdanie po polsku — co w wyniku wyszukiwania przekonało cię, że ta strona publikuje wydarzenia
(np. "kalendarz imprez GOK w opisie wyniku"). To pole trafia do rejestru i po miesiącach jest jedyną
odpowiedzią na pytanie „czemu ten adres tu jest?". Nie powtarzaj nazwy instytucji, nie pisz ogólników.`;

export const DISCOVERY_QUERIES: readonly string[] = [
  "{town} dom kultury wydarzenia",
  "{town} ośrodek kultury",
  "{town} biblioteka wydarzenia dla dzieci",
  "{town} OSiR wydarzenia",
  "{town} kalendarz wydarzeń urząd",
  "{town} co robić z dzieckiem",
  "site:facebook.com {town} wydarzenia",
  "site:facebook.com/groups {town}",
  "{town} grupa facebook wydarzenia lokalne",
  "wydarzenia {town}",
];

// ============ STAGE 1b: weryfikacja/naprawa URL-i (miesięcznie, tani model) ============

/**
 * Wybór adresu, pod którym serwis WYPISUJE wydarzenia — jedno tanie wywołanie na źródło.
 *
 * Heurystyki znajdują kandydatów i mierzą je liczbą powtarzalnych odnośników, ale nie
 * odróżnią „listy wydarzeń" od „listy przetargów": jedna i druga to trzydzieści linków
 * o tym samym kształcie. Model dostaje więc DOWODY (ile odnośników, jaki szablon, próbka
 * tekstu), a nie samo pytanie — i ma prawo powiedzieć „to nie jest strona z wydarzeniami".
 *
 * `verdict:"none"` jest tu najważniejszą odpowiedzią: to ono utrzymuje obietnicę, że rejestr
 * dla nowego miasta da się przyjąć bez oglądania każdej strony z osobna.
 */
export const ENTRYPOINT_SYSTEM = `Dostajesz kandydatów na podstronę instytucji, która wypisuje WYDARZENIA
(kalendarz, aktualności, repertuar, imprezy). Przy każdym: adres, liczba powtarzalnych odnośników
do podstron, wykryty szablon tych odnośników i próbka tekstu strony.
Wybierz JEDEN adres, pod którym najlepiej widać LISTĘ nadchodzących wydarzeń z datami.
Preferuj stronę z wieloma wpisami i datami nad stroną pojedynczego wydarzenia lub opisem instytucji.
Odrzuć: archiwa i relacje z minionych imprez, galerie zdjęć, przetargi/BIP, ogłoszenia urzędowe,
cenniki i regulaminy.
Zwróć WYŁĄCZNIE JSON:
{"url":"<adres>","alt":["<inny sensowny adres>"],"verdict":"events|news|none","why":"<jedno zdanie po polsku>"}
- "events": lista wydarzeń z terminami,
- "news": aktualności, w których wydarzenia bywają wymieszane z ogłoszeniami (nadal użyteczne),
- "none": żaden kandydat nie wypisuje wydarzeń — wtedy "url" ustaw na null.
"why" trafia do rejestru i po miesiącach jest jedyną odpowiedzią na pytanie „czemu wchodzimy tym adresem?".`;

export const REVERIFY_SYSTEM = `Instytucja kultury/sportu w Polsce ma martwy URL w naszym rejestrze źródeł wydarzeń.
Dostajesz jej nazwę, miasto, stary URL i wyniki wyszukiwania. Wskaż aktualną OFICJALNĄ stronę tej instytucji
(najlepiej podstronę z wydarzeniami/aktualnościami/kalendarzem). Odrzuć: agregatory biletowe, katalogi firm,
portale ogłoszeniowe, media lokalne piszące O instytucji oraz strony innych instytucji o podobnej nazwie.
Zwróć WYŁĄCZNIE JSON: {"url":"https://..."} albo {"url":null}, gdy żaden wynik nie jest jej oficjalną stroną.`;

// ============ STAGE 2: ekstrakcja (codziennie, tani model) ============

export const extractionSystem = (todayIso: string): string =>
  `Wyciągasz wydarzenia lokalne z tekstu strony/PDF-a. Dziś jest ${todayIso}.
Zwróć WYŁĄCZNIE poprawny JSON: {"events":[...],"followups":[...]}.

Schemat wydarzenia:
${EVENT_BLOCK}

WYDARZENIA-KONTENERY: jeśli tekst zawiera zbiorczy program (repertuar, "Akcja Lato", festiwal wielodniowy)
z konkretnymi terminami — rozbij na osobne wydarzenia i ustaw "container": nazwa kontenera.
Jeśli program jest POD LINKIEM (PDF, podstrona, plakat JPG) — NIE zgaduj; dodaj URL do "followups":
[{"url": str, "reason": "program PDF"|"szczegóły wydarzenia"|"plakat"}]. Maks 5 followupów, tylko z tej samej domeny lub oficjalnych.

Nie wymyślaj danych. Brak informacji zapisuj tak, jak pokazuje schemat: null tam, gdzie w typie jest "|null",
a pusty string "" w polach czysto tekstowych (venue, town, registration, conditional, container). Daty przeszłe pomijaj.

BEZ DATY = NIE WYDARZENIE. Pomijaj atrakcje stałe i całoroczne (zoo, muzeum, plac zabaw,
park linowy, basen, „czynne codziennie", oferta stała, cennik biletów) — od tego są mapy,
nie ten serwis. Jeśli nie da się ustalić konkretnego "date_start", NIE dodawaj wpisu.`;

/**
 * Plakat leci do modelu BEZ promptu ekstrakcji (osobne wywołanie, osobny system), więc
 * schemat musi być tutaj. Do 2026-07 go nie było — prompt odsyłał do „tego samego schematu",
 * którego model w tym wywołaniu nigdy nie widział.
 */
export const POSTER_SYSTEM = `Na obrazie jest plakat wydarzenia (PL). Wyciągnij dane i zwróć WYŁĄCZNIE JSON
{"events":[...],"followups":[]}. Schemat wydarzenia:
${EVENT_BLOCK}

Zwróć uwagę na: daty, godziny, miejsce, ceny, ograniczenia wiekowe, program wielogodzinny.
Bez konkretnego "date_start" nie zwracaj wpisu — plakat oferty stałej pomiń.`;

export const DEDUPE_SYSTEM = `Dostajesz listę wydarzeń z różnych źródeł. Znajdź duplikaty (to samo wydarzenie
opisane przez urząd, GOK i FB). Kryteria: zbliżony tytuł/data/miejsce. Zwróć JSON:
{"groups":[[idx,idx,...],...]} — indeksy duplikatów. Zachowaj najbogatszy opis jako kanoniczny.`;
