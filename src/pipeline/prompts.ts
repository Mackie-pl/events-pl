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
import { BlockEventSchema, EventSchema } from "../types/event-schema.js";

const EVENT_BLOCK = renderSchemaBlock(EventSchema);

/**
 * Reguła cykliczności — wspólna dla obu promptów ekstrakcji, bo plakat generuje serie
 * CZĘŚCIEJ niż strona: „Kalendarz wydarzeń na plaży (czerwiec–lipiec)" to jedna „Animacja
 * dla dzieci" powtórzona trzydzieści razy, a wywołanie plakatowe ma sufit 2000 tokenów,
 * więc bez tej reguły odpowiedź nie tyle drożeje, co po prostu zostaje ucięta.
 *
 * Model podaje RYTM, konkretne daty wylicza potok (shared/series.ts). Odwrotny podział
 * nie działa: „w każdą sobotę od 20.06 do 31.08" to dla taniego modelu dwadzieścia działań
 * na kalendarzu, a tam się myli.
 *
 * Ostatnie zdanie nie jest ozdobą. W events.json stoją obok siebie „Kino letnie w Wirach"
 * (jedna seria) i „Kino letnie w Wirach - seans: Nomadland" (osobne filmy) — te drugie mają
 * zostać osobno, bo różnią się treścią, a nie tylko terminem.
 */
const RECURRING_RULE = `WYDARZENIA CYKLICZNE: gdy ten sam wpis powtarza się w regularnym rytmie
(„codziennie", „w każdą sobotę i niedzielę", „wtorki i czwartki") — NIE wypisuj każdego terminu osobno.
Zwróć JEDEN wpis: "date_start" = pierwszy termin, "date_end" = ostatni, "repeat" = rytm. Konkretne daty
wyliczy potok. Gdy terminy są nieregularne albo każdy ma inny tytuł/program (repertuar kina, kolejne
seanse) — zostaw "repeat":"" i wypisz je osobno.`;

// ============ STAGE 1: discovery (raz w miesiącu, mocny model) ============

/**
 * Uwaga na cudzysłowy w tym prompcie — modele przepisują jego typografię.
 *
 * Luboń, 2026-08-02: model odpowiedział `"why": "…o nazwie „Wydarzenia w Luboniu"…"` — polski
 * cudzysłów otwierający, ASCII zamykający, czyli literał JSON-a urwany w połowie wartości.
 * Bez structured outputs kosztowało to trzy ostatnie propozycje (wszystkie grupy FB), z nimi
 * gramatyka domyka string na tym znaku i zdanie zostaje ucięte w pół. Prompt sam pokazywał
 * ten wzorzec w zdaniu o „czemu ten adres tu jest" — stąd zakaz i stąd przykłady bez cudzysłowów.
 */
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
(np. kalendarz imprez GOK w opisie wyniku). To pole trafia do rejestru i po miesiącach jest jedyną
odpowiedzią na pytanie, czemu ten adres tu jest. Nie powtarzaj nazwy instytucji, nie pisz ogólników.
W polach tekstowych NIE UŻYWAJ ŻADNYCH CUDZYSŁOWÓW — nazwy własne podawaj gołym tekstem.`;

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

/**
 * Reguły ekstrakcji — WSPÓLNE dla wywołania na jedną treść i na paczkę bloków.
 *
 * Stoją w osobnej stałej, bo prompt zbiorczy różni się tylko nagłówkiem i schematem;
 * gdyby reguły były w obu przepisane, rozjechałyby się dokładnie tak, jak rozjechały się
 * kiedyś trzy kopie bloku schematu. `test/prompts.test.ts` pilnuje, że wersja pojedyncza
 * po tym wydzieleniu jest CO DO ZNAKU tym samym promptem, co przedtem.
 */
const EXTRACTION_RULES = `WYDARZENIA-KONTENERY: jeśli tekst zawiera zbiorczy program (repertuar, "Akcja Lato", festiwal wielodniowy)
z konkretnymi terminami — rozbij na osobne wydarzenia i ustaw "container": nazwa kontenera.
Jeśli program jest POD LINKIEM (PDF, podstrona, plakat JPG) — NIE zgaduj; dodaj URL do "followups":
[{"url": str, "reason": "program PDF"|"szczegóły wydarzenia"|"plakat"}]. Maks 5 followupów, tylko z tej samej domeny lub oficjalnych.
URL przepisz DOKŁADNIE tak, jak stoi w tekście — także względny („/images/…"). NIE doklejaj domeny i niczego nie poprawiaj.

${RECURRING_RULE}

Nie wymyślaj danych. Brak informacji zapisuj tak, jak pokazuje schemat: null tam, gdzie w typie jest "|null",
a pusty string "" w polach czysto tekstowych (venue, town, registration, conditional, container). Daty przeszłe pomijaj.

BEZ DATY = NIE WYDARZENIE. Pomijaj atrakcje stałe i całoroczne (zoo, muzeum, plac zabaw,
park linowy, basen, „czynne codziennie", oferta stała, cennik biletów) — od tego są mapy,
nie ten serwis. Jeśli nie da się ustalić konkretnego "date_start", NIE dodawaj wpisu.`;

/**
 * Zasada czytania KONTEKSTU PROGRAMU — zdania o tym, czym jest właśnie czytana podstrona.
 *
 * Jedzie w wiadomości użytkownika, a nie w prompcie systemowym, bo dotyczy wyłącznie sond
 * kontenerów (`extract/container.ts`): dopisana do systemowego kosztowałaby ~80 tokenów
 * w KAŻDYM wywołaniu ekstrakcji, w tym w tych czterdziestu dziennie, które żadnego kontekstu
 * nie dostają.
 *
 * Po co w ogóle: strona programu opisuje zajęcia RYTMEM, nie datami — „Zajęcia odbywają się
 * w poniedziałki nad Maltą w godzinach 12:00 – 13:30" (okpoznan.pl, „Seniorzy w akcji",
 * sprawdzone 2026-08-18). Daty granicznej nie ma na niej wcale: stoi na KARCIE, z której
 * przyszliśmy („Lip 27 – Sie 31"). Bez tego zdania model stosuje regułę „bez konkretnego
 * date_start nie dodawaj wpisu" i słusznie oddaje z takiej strony ZERO zajęć — zmierzone,
 * pierwsza sonda tej podstrony dała 5 wydarzeń, wszystkie z ramki „INNE WYDARZENIA".
 *
 * Kierunek jest asymetryczny, dokładnie jak przy plakacie: kontekst UZUPEŁNIA stronę, nigdy
 * jej nie zastępuje. Zakres z karty ma wypełnić brakujące granice rytmu i nic ponadto.
 */
export const PROGRAM_CONTEXT_RULE = `KONTEKST: poniższe zdanie mówi, czym jest ta podstrona.
Użyj go WYŁĄCZNIE do uzupełnienia tego, czego na stronie nie ma: gdy wpis podaje RYTM
(„w poniedziałki", „we wtorki", „w każdą sobotę"), ale nie podaje dat granicznych, weź je
z kontekstu — "date_start" i "date_end" z podanego zakresu, "repeat" z rytmu ze strony.
STRONA WYGRYWA z kontekstem zawsze, gdy sama coś datuje — także nagłówkiem sekcji
(„Zajęcia od września 2026", „w sezonie zimowym"). Wpisu spod takiego nagłówka NIE wciągaj
w zakres z kontekstu; jeśli nie umiesz ustalić jego terminu, pomiń go.
Nie twórz wpisów dla wydarzeń, które stoją tylko w kontekście, i nie powielaj samego
programu jako wydarzenia.`;

export const extractionSystem = (todayIso: string): string =>
  `Wyciągasz wydarzenia lokalne z tekstu strony/PDF-a. Dziś jest ${todayIso}.
Zwróć WYŁĄCZNIE poprawny JSON: {"events":[...],"followups":[...]}.

Schemat wydarzenia:
${EVENT_BLOCK}

${EXTRACTION_RULES}`;

/**
 * Prompt ZBIOROWY: kilka fragmentów tej samej strony w jednym wywołaniu.
 *
 * Powód jest arytmetyczny. Prompt systemowy waży ~900 tokenów, więc przy wywołaniu na blok
 * pierwszy przebieg źródła (trzydzieści kilka nieznanych bloków) kosztuje kilkanaście razy
 * więcej niż jedno wywołanie na całą stronę — pomiar na `estrada` dał 33 wywołania i $0.244
 * zamiast ~$0.02. Paczka sprowadza zasiew z powrotem do jednego wywołania.
 *
 * Cena za to jest jedna: model MUSI podpisać każdy wpis numerem bloku. To jedyne, co pozwala
 * rozpisać odpowiedź z powrotem na osobne wpisy cache'a — a bez tego przypisania znikająca
 * karta nie miałaby jak zabrać ze sobą swoich wydarzeń.
 */
export const batchExtractionSystem = (todayIso: string): string =>
  `Wyciągasz wydarzenia lokalne z FRAGMENTÓW jednej strony. Dziś jest ${todayIso}.
Fragmenty są ponumerowane i rozdzielone wierszem „BLOK n:". Czytaj każdy osobno — to kawałki
tej samej strony, ale osobne wpisy.
Zwróć WYŁĄCZNIE poprawny JSON: {"events":[...],"followups":[...]}.

KAŻDY wpis w "events" i w "followups" MUSI mieć pole "block" z numerem bloku, w którym stoi.
Numer przepisz z nagłówka „BLOK n:" stojącego nad tą treścią. Nie zgaduj i nie przenoś wpisu
do innego bloku — po tym numerze wynik wraca na swoje miejsce.

Schemat wydarzenia:
${renderSchemaBlock(BlockEventSchema)}

${EXTRACTION_RULES}`;

/**
 * Zasada czytania KONTEKSTU — tekstu, w którym plakat stał (blok strony albo post FB).
 *
 * Kontekst dokłada się do wywołania, bo plakat notorycznie nie niesie roku („sobota, 23
 * sierpnia") ani miejsca, które autor napisał w podpisie zamiast na grafice. To kilkaset
 * tokenów obok ~1.7 tys. za sam obraz, więc pytanie brzmi wyłącznie „czy pomaga", nie „czy stać nas".
 *
 * Kierunek jest jednak asymetryczny i to jest tu cała reguła: kontekst UZUPEŁNIA plakat,
 * nigdy go nie zastępuje. Odwrotnie kończy się dokładnie tak, jak „Wieczór Grecki" z datą
 * przebiegu zamiast 21 sierpnia (patrz extract/date-hint.ts) — z tą różnicą, że tam
 * bezpiecznik złapał zmyśloną datę po tekście dowodu, a tutaj dowodem są PIKSELE,
 * których żaden bezpiecznik nie przeczyta. Zły termin z podpisu nie ma się o co zatrzymać.
 */
const POSTER_CONTEXT_RULE = `Razem z obrazem możesz dostać KONTEKST — tekst, przy którym plakat stał.
Kontekst służy WYŁĄCZNIE do uzupełnienia tego, czego na plakacie nie ma (najczęściej rok,
miasto, adres) i do rozstrzygnięcia niejasności. Wydarzenie ma pochodzić z PLAKATU.
Jeśli plakat nie podaje terminu, NIE bierz daty z kontekstu — data publikacji postu to nie
jest data wydarzenia. Nie twórz wpisów dla wydarzeń, które stoją tylko w kontekście.`;

/**
 * Plakat leci do modelu BEZ promptu ekstrakcji (osobne wywołanie, osobny system), więc
 * schemat musi być tutaj. Do 2026-07 go nie było — prompt odsyłał do „tego samego schematu",
 * którego model w tym wywołaniu nigdy nie widział.
 */
export const POSTER_SYSTEM = `Na obrazie jest plakat wydarzenia (PL). Wyciągnij dane i zwróć WYŁĄCZNIE JSON
{"events":[...]}. Schemat wydarzenia:
${EVENT_BLOCK}

Zwróć uwagę na: daty, godziny, miejsce, ceny, ograniczenia wiekowe, program wielogodzinny.
Bez konkretnego "date_start" nie zwracaj wpisu — plakat oferty stałej pomiń.

${POSTER_CONTEXT_RULE}

${RECURRING_RULE}`;

export const DEDUPE_SYSTEM = `Dostajesz listę wydarzeń z różnych źródeł. Znajdź duplikaty (to samo wydarzenie
opisane przez urząd, GOK i FB). Kryteria: zbliżony tytuł/data/miejsce. Zwróć JSON:
{"groups":[[idx,idx,...],...]} — indeksy duplikatów. Zachowaj najbogatszy opis jako kanoniczny.`;
