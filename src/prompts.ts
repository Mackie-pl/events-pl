/** Prompty dla obu etapów pipeline'u. */

// ============ STAGE 1: discovery (raz w miesiącu, mocny model) ============

export const DISCOVERY_SYSTEM = `Jesteś asystentem budującym rejestr źródeł lokalnych wydarzeń w Polsce.
Dostajesz wyniki wyszukiwania dla miasta/gminy. Wybierz strony, które PUBLIKUJĄ wydarzenia:
- portale urzędów miast/gmin (kalendarze, aktualności)
- ośrodki/domy kultury (uwaga: duże miasta mają DK w każdej dzielnicy — szukaj wszystkich)
- biblioteki, OSiR-y, muzea, teatry, galerie
- publiczne strony/fanpage FB instytucji i miejsc (plaże miejskie, parki, kawiarnie z eventami)
Odrzuć: agregatory biletowe, katalogi firm, strony martwe/archiwalne.
Zwróć JSON: {"sources":[{"id","name","type","url","town","fetch":"plain|headless|pdf|api|fb","confidence":0-1,"notes"}]}
Typy: city_portal, culture_center, library, sports, venue, fb_page, rss, api, pdf_program.`;

export const DISCOVERY_QUERIES: readonly string[] = [
  "{town} dom kultury wydarzenia",
  "{town} ośrodek kultury",
  "{town} biblioteka wydarzenia dla dzieci",
  "{town} OSiR wydarzenia",
  "{town} kalendarz wydarzeń urząd",
  "{town} co robić z dzieckiem",
  "site:facebook.com {town} wydarzenia",
];

// ============ STAGE 2: ekstrakcja (codziennie, tani model) ============

export const extractionSystem = (todayIso: string): string =>
  `Wyciągasz wydarzenia lokalne z tekstu strony/PDF-a. Dziś jest ${todayIso}.
Zwróć WYŁĄCZNIE poprawny JSON: {"events":[...],"followups":[...]}.

Schemat wydarzenia:
{
 "title": str,
 "date_start": "YYYY-MM-DD",            // wywnioskuj rok z kontekstu; pomiń wydarzenia zakończone przed ${todayIso}
 "date_end": "YYYY-MM-DD"|null,
 "time_start": "HH:MM"|null,
 "time_end": "HH:MM"|null,
 "venue": str|null,                      // pełna nazwa miejsca + adres jeśli podany
 "town": str|null,
 "price": {"free": bool|null, "amount_pln": num|null, "note": str|null},
 "age": {"min": int|null, "max": int|null, "label": str|null},   // "4+"→min:4; "roczniki 2015-2016"→przelicz na wiek; "dorośli"→min:18
 "family_friendly": true|false|"maybe",
 "tags": [str],                          // zagnieżdżone, np. "dzieci:dmuchańce", "warsztaty:ceramika", "muzyka:koncert", "sport:rower", "film:plener"
 "registration": str|null,               // telefon/link do zapisów jeśli jest
 "sub_slots": [{"time":"HH:MM","label":str,"age":{...}|null}]|null,  // etapy wydarzenia (np. 12-18 dzieci, 18-22 dorośli)
 "conditional": str|null,                // np. "przy deszczu przeniesione na 26.07"
 "source_url": str,
 "is_noise": bool                        // komisje rady, wybory sołeckie, przetargi, ogłoszenia urzędowe → true
}

WYDARZENIA-KONTENERY: jeśli tekst zawiera zbiorczy program (repertuar, "Akcja Lato", festiwal wielodniowy)
z konkretnymi terminami — rozbij na osobne wydarzenia i ustaw "container": nazwa kontenera.
Jeśli program jest POD LINKIEM (PDF, podstrona, plakat JPG) — NIE zgaduj; dodaj URL do "followups":
[{"url": str, "reason": "program PDF"|"szczegóły wydarzenia"|"plakat"}]. Maks 5 followupów, tylko z tej samej domeny lub oficjalnych.

Nie wymyślaj danych. null gdy brak. Daty przeszłe pomijaj.`;

export const POSTER_SYSTEM = `Na obrazie jest plakat wydarzenia (PL). Wyciągnij dane wg tego samego schematu JSON
{"events":[...]}. Zwróć uwagę na: daty, godziny, miejsce, ceny, ograniczenia wiekowe, program wielogodzinny.`;

export const DEDUPE_SYSTEM = `Dostajesz listę wydarzeń z różnych źródeł. Znajdź duplikaty (to samo wydarzenie
opisane przez urząd, GOK i FB). Kryteria: zbliżony tytuł/data/miejsce. Zwróć JSON:
{"groups":[[idx,idx,...],...]} — indeksy duplikatów. Zachowaj najbogatszy opis jako kanoniczny.`;
