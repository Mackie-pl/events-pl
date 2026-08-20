# Otwarte wątki

Rzeczy ustalone w trakcie pracy, których **nie ma gdzie zapisać w kodzie**, bo dotyczą decyzji
jeszcze niepodjętych albo pomiarów, które trzeba powtórzyć. To nie jest lista życzeń — każdy wpis
ma powód i, tam gdzie się dało, liczbę.

Rzeczy JUŻ rozstrzygnięte mieszkają w README i w komentarzach przy kodzie, nie tutaj. Jeśli wpis
stąd zostaje zamknięty, przenieś uzasadnienie do kodu i skasuj go z tej listy.

---

## 1. Eval promptów i modeli

Powód, dla którego to jest najwyżej na liście: **wszystkie zmiany z sierpnia 2026 poszły
w ciemno.** Nowe limity tokenów, structured outputs, wycięty `header` — każda z nich
„wygląda lepiej" i żadnej nie umiemy zmierzyć.

### Co już jest, a czego nie ma

- `eval/lato-z-biblioteka.json` — jeden ręcznie oznaczony przypadek (plakat, 25 wydarzeń,
  14 oczekiwanych po odsiewie przeszłych). **Bez runnera.**
- `state.json` — 110 zapisanych ekstrakcji, 57 z niezerowym plonem, 194 wydarzenia. To nie jest
  prawda absolutna, ale do pytania „czy wariant nie degraduje" wystarcza **punkt odniesienia**.
- Wejścia odtwarzają się za darmo (strony pobierają się ponownie), a pełne treści są w prywatnym
  archiwum Supabase.
- Tożsamość wydarzenia do porównywania wyników: `shared/event-key.ts` — ta sama, którą scala potok.

### Warianty do porównania

| | blok schematu w prompcie | `response_format` |
|---|---|---|
| A (dziś) | tak | tak |
| B | **nie** | tak |
| C (kontrola) | tak | nie |

Mierzyć: pokrycie względem referencji, wydarzenia znalezione DODATKOWO (zysk czy halucynacja —
to jedyne miejsce, gdzie potrzeba człowieka), zgodność pól ocennych (`is_noise`, `family_friendly`,
`price.free`), odrzuty walidacji, tokeny, koszt.

**Powtórki są obowiązkowe.** `temperature: 0.2` to nie zero; bez powtórzeń zmierzy się wariancję
zamiast efektu.

Koszt: średnie wywołanie ekstrakcji $0.0133 (53 wywołania × $0.7026 w przebiegu 2026-08-01).
20 stron × 3 warianty × 2 powtórki ≈ **$1,6**.

### Druga oś tego samego narzędzia — ważniejsza niż pierwsza

`MODEL_EXTRACT` jest podmieniany z `.env` i **nie ma dziś żadnego sposobu, żeby porównać modele**.
Pytanie „czy zejdziemy na tańszy" albo „czy nowszy jest lepszy" jest warte wielokrotnie więcej niż
oszczędność z punktu 2. Warto to przewidzieć w projekcie runnera, a nie doklejać potem.

---

## 2. Blok schematu w prompcie jest zdublowany

`extractionSystem()` zawiera `renderSchemaBlock(EventSchema)` (1827 znaków, ~520 tokenów), a przy
włączonym `response_format` ten sam kształt leci drugi raz jako JSON Schema (~2300 tokenów narzutu).
Przy 53 wywołaniach dziennie to rząd **$1,5/mies.** za opisanie kształtu dwa razy.

**Co już wiadomo bez evala:** `renderSchemaBlock` wypisuje `description` każdego pola jako komentarz,
a `toWireSchema` zdejmuje wyłącznie `x-render` i `default` — czyli opisy pól docierają do modelu
OBIEMA drogami. Informacyjnie nic się nie gubi.

**Czego nie wiadomo:** czy model tak samo *korzysta* z opisów w skompilowanym schemacie, jak z prozy
w prompcie. `response_format` to ograniczone dekodowanie, inny mechanizm niż uwaga na tekst systemowy.
Pola ocenne (`is_noise`, `family_friendly: "maybe"`, wnioskowanie roku) to najbardziej narażony obszar.

Reguły MIĘDZYpolowe (kontenery, followupy, „bez daty = nie wydarzenie") zostają prozą niezależnie od
decyzji — ale stoją tuż obok bloku, więc eval musi sprawdzić, czy wycięcie sąsiada ich nie osłabia.

Zablokowane na punkcie 1. **Sam z siebie nie uzasadnia budowy evala.**

---

## 3. Źródła jałowe ze statusem `error`

`--yield` na 5 przebiegach pokazał 25 jałowych źródeł. Trzy z `status: empty` naprawione (ucięcie
odpowiedzi + structured outputs). **Zostają te z `error`, nietknięte:**

`ck-zamek` ($0.0803) · `mosina-osir` ($0.0413) · `lubon-biblioteka` ($0.0125) ·
`kornik-arboretum` ($0.0100) · `biblraczynskich` ($0.0094) · `puszczykowo-bmcak` ($0.0065) ·
`dk-orbita` ($0.0056)

Nie diagnozowane. Każde kosztuje mimo błędu, więc płacimy za wywołania, które i tak nie kończą się
wydarzeniem. Zacząć od `ck-zamek`, bo jest najdroższe.

Sposób: `npm run discover -- --why <id>` daje historię weryfikacji, `npm run probe -- <id>` sprawdza
jedno źródło na żądanie.

---

## 4. Profiler entrypointów: dwie wady widziane na żywo

### 4a. Brak werdyktu „archiwalne"

`gazeta-lubon.pl/2025/kalendarium-wydarzen-miejskich-4/` wszedł do rejestru z `confidence 0.88`
i werdyktem profilera `events`. Strona jest prawdziwym kalendarium — **z listopada 2025**.
W treści stoi wprost `Redakcja GL 3 listopada, 2025`, a profiler ją pobrał (55 546 znaków).

Werdykt to zamknięty zbiór `events | news | none`, więc model nie ma jak powiedzieć „lista wydarzeń,
ale zeszłoroczna". `events` jest formalnie poprawną odpowiedzią. **Brakuje czwartej wartości**
(`stale`) — prompt już zresztą mówi „lista NADCHODZĄCYCH wydarzeń".

Uwaga: sygnału świeżości NIE MA w wynikach wyszukiwarki. Sonda 2026-08-01 — Serper zwraca dla tych
zapytań wyłącznie `title, link, snippet, position`, **bez pola `date`**. Triage discovery widzi więc
tylko rok w URL-u. Naprawa musi siedzieć w profilerze, który ma treść strony.

Sieć bezpieczeństwa działa, ale wolno: `BARREN_LIMIT = 2`, czyli dwa dni płatnej ekstrakcji zanim
entrypoint wypadnie.

### 4b. Menu nawigacyjne udaje listing

`lubon.pl/kalendarium/5/1/5` dostał `confidence 0.9` i `detailCount: 56` ze wzorcem
`/artykuly/{id}/{slug}`. To **nie są wpisy kalendarza — to linki menu**. Cała strona po odtagowaniu
to 4188 znaków samej nawigacji („Urząd Miasta · Dane adresowe · Odpady · Podatki…"), zero wydarzeń.

Na tym CMS-ie sama nawigacja produkuje przekonującą sygnaturę listingu: kilkadziesiąt odnośników
o identycznym kształcie. Heurystyka policzyła je poprawnie i wyciągnęła fałszywy wniosek, a model
dostał już tylko gotowe „56 powtarzalnych odnośników" jako dowód.

Kierunek naprawy: liczyć `detailCount` **z pominięciem odnośników wspólnych dla całego serwisu**
(te same linki na kilku pobranych stronach = chrom, nie treść).

Uboczne znalezisko, prawdopodobnie lepsze niż naprawa tego adresu: weryfikacja wykryła
`lubon.pl/atom` i `lubon.pl/rss` — **100 pozycji, 18 z sparsowaną datą**. Feed jest darmowy,
nie wymaga modelu i ma realną treść.

---

## 5. `--yield`: czego ten rachunek NIE mierzy

Obie rzeczy są wypisane w stopce raportu, ale wymagają decyzji, a nie tylko świadomości.

- **Utrata wyprzedzenia.** „Wyłączne" znaczy „w tym oknie nikt inny tego nie dał". Źródło, które
  publikuje jako pierwsze, a resztę i tak dopisują inni, wyjdzie na zbędne — choć traciłoby się na
  nim dni. Do zmierzenia trzeba by porównywać DATY pierwszego wystąpienia klucza per źródło; dane
  na to są (`runs.json` trzyma 7 dni), brakuje rachunku.
- **Klucz scalania jest zgrubny.** `shared/event-key.ts`: tytuł bez znaków specjalnych, obcięty
  do 40 znaków, + data. „Fiesta" i „Fiesta 2026" to osobne wydarzenia, `\W+` bez flagi `u` zjada
  polskie znaki („Święto" → „wito"). Błąd idzie w bezpieczną stronę (nakładanie ZANIŻONE), więc
  na dziś wystarcza — ale zaostrzenie klucza zmienia wynik scalania w CAŁYM potoku, nie tylko
  w raporcie. To osobna decyzja z własnym evalem.
- W `dedupe.ts` czeka nieużywany `DEDUPE_SYSTEM` (`void DEDUPE_SYSTEM; // podpięcie LLM-dedupe: TODO`)
  — rozjemca dla par niejednoznacznych. Sensowny dopiero po zaostrzeniu klucza.

Pierwszy pomiar (5 przebiegów, 46 źródeł): **zero źródeł redundantnych**, 25 jałowych za $0.7414
na przebieg. Nakładanie istnieje (komorniki-city ↔ komorniki-gok: 19 wspólnych wydarzeń), ale każde
źródło ma coś wyłącznie swojego. **Hipoteza o nadmiarze w rejestrze się nie potwierdziła** — do
powtórzenia, gdy `daily` zobaczy grupy FB Lubonia, bo tego przypadku okno jeszcze nie objęło.

---

## 6. Discovery wpuszcza wszystko — ale odsiew NIE jest tam, gdzie go szukaliśmy

Pierwotna obserwacja: przebieg dla Lubonia to **15 propozycji, 15 dodanych, zero odrzuceń**,
w tym pięć grup FB dla 30-tysięcznego miasta — bo 3 z 10 zapytań w `DISCOVERY_QUERIES` są FB-owe,
a `MIN_CONFIDENCE = 0.5` przepuszcza wszystko od 0.75 w górę. Wniosek brzmiał: dołożyć limit
na gminę i typ.

**Pomiar z 2026-08-02 ten wniosek odwraca.** Cztery przebiegi `--reset "Luboń" 1` w dobę: 17 różnych
źródeł, tylko **9 w każdym przebiegu**. Wyszukiwarka stabilna (59-61 adresów, ±3%), więc 9 z 10
pominięć to „model widział wynik i go nie wziął" — m.in. `lubon.pl/news/content/4766`, oficjalny
kalendarz imprez miejskich na 2026, nieobecny w jednym przebiegu na cztery.

Czyli `MIN_CONFIDENCE` nie jest wąskim gardłem: **model odsiewa ~połowę sam, bez uzasadnienia
i bez powtarzalności**, zanim cokolwiek dojdzie do progu. Limit na gminę i typ dokładałby drugi
odsiew nad pierwszym, którego nie kontrolujemy — i kosztowałby dokładnie te źródła, które i tak
wypadają najczęściej.

Właściwe pytanie brzmi więc inaczej: czy filtr ma zostać w triage'u (gust modelu, jedno losowanie),
czy przenieść się do weryfikacji, która i tak pobiera stronę i ocenia ją na dowodach (~$0.003/źródło,
przy 60 kandydatach ≈ +$0.05 na przebieg). To zmiana projektowa, nie parametr.

Doraźnie kosztu nie ma: budowanie rejestru bez `--reset` sumuje przebiegi, a pudło degraduje
zamiast kasować (patrz `resetRegistry` w actions/discover.ts oraz reconcile.ts). Punkt 5 dalej
z przodu — może się okazać, że te grupy zarabiają na siebie.

---

## 7. Kodowanie znaków: `swarzedz.pl` idzie do modelu jako mojibake

Znalezione przy okazji pomiaru tożsamości kart (2026-08-08), nie szukane.

`https://www.swarzedz.pl/` serwuje treść w kodowaniu jednobajtowym (ISO-8859-2 albo
windows-1250), a `res.text()` w `adapters/page-fetch.ts` dekoduje **zawsze jako UTF-8**.
Efekt widać wprost w blokach:

```
Strona korzysta z plików cookies w celu realizacji us�ug �wiadczonych przez nasz serwis.
Mo�esz okre�li� warunki przechowywania lub dost�pu do plik�w cookies
```

Skala: 33 karty, źródło pobierane **codziennie**, więc model codziennie czyta popsute polskie
znaki. Nie wiadomo, ile to kosztuje w jakości — tytuły z „ą/ę/ś/ż" trafiają do `events.json`
w tej postaci albo zgadywane od nowa.

Czego NIE wiadomo i co trzeba zmierzyć przed poprawką:

- ile źródeł w rejestrze serwuje nie-UTF-8 (sprawdzić `Content-Type: charset=` oraz BOM/heurystykę
  na pobranej treści — nagłówek bywa kłamliwy),
- czy `res.arrayBuffer()` + `TextDecoder(charset)` wystarczy, czy potrzeba wykrywania z treści
  dla serwerów bez `charset` w nagłówku.

Uwaga na pułapkę: poprawka **zmieni hash treści** każdego takiego źródła, więc pierwszy przebieg
po niej przeczyta te strony od nowa (cache bloków i cache strony chybią raz). To jednorazowe
i spodziewane — nie mylić z regresem.

---

## 8. Wydarzenia bez godziny — i skąd naprawdę bierze się ten brak

Zmierzone na `events.json` z 2026-08-12: **125 z 321 wydarzeń (38%) nie ma `time_start`.**
Liczba jest jednak myląca i rozpada się na trzy różne sprawy, z których tylko jedna jest luką:

- **47** to zakresy i serie, gdzie godzina startu bywa bez sensu. Wystawa czynna od lipca do
  października ma godziny otwarcia, nie godzinę rozpoczęcia — `null` jest tam POPRAWNĄ
  odpowiedzią, nie brakiem. Ewentualna praca jest tu w renderze (napisać „cały dzień"),
  nie w ekstrakcji.
- **78** to wydarzenia jednodniowe, czyli luka właściwa. Rozkład: `posir-poznan` 14,
  grupy FB ~27 (pięć źródeł), `biblioteka-lubon-www` 5, `okpoznan-wydarzenia` 5.
- Osobno: godziny **wymyślone**, czyli stan gorszy od braku (patrz 8b).

### 8a. Godzina bywa o jeden klik dalej, ale to NIE jest częsty przypadek

`DO UTRATY TCHU | REPREMIERA` (`ck-zamek`, 12.08) wszedł bez godziny, bo karta na
`ckzamek.pl` niesie wyłącznie datę — sprawdzone w źródle strony:

```
|Do utraty tchu | repremiera| |Rekonstrukcja 4K…| |Data| 12.08.2026
```

Repertuar z godzinami stoi pod linkiem karty, `kinopalacowe.pl/filmy/14738-…`, i ten adres
NIGDY nie został pobrany: `state.followupsBySource["ck-zamek"]` to `[]` przy 20 blokach.
Powód jest w prompcie — followupy wolno brać „tylko z tej samej domeny lub oficjalnych",
a Kino Pałacowe to inna domena, choć jest kinem tego samego CK Zamek. Model nie ma jak tego
wiedzieć i zastosował regułę poprawnie co do litery.

Asymetria, która jest tu właściwym znaleziskiem: **`source_url` przyjął obcą domenę
(model rozpoznał stronę wydarzenia), a `followups` tej samej domeny już nie wpuściły.**

**Dlaczego to NIE jest do naprawy teraz.** Zmierzone przed napisaniem czegokolwiek: wydarzeń
bez godziny, które mają `source_url` na innej domenie niż źródło (pomijając FB), jest w całym
pliku **5** — a dwa z nich to `docs.google.com` i `forms.gle`, czyli linki do zapisów, nie
strony wydarzeń. Poluzowanie reguły followupów odzyskałoby **trzy** godziny. `ck-zamek` jest
rzadkim kształtem, nie wzorcem — a każdy taki followup to pobranie plus wywołanie modelu.

Większą dźwignią jest ścieżka plakatów z grup FB (~27 wydarzeń, i plakat zwykle niesie naraz
godzinę I miejsce). Pomiar, który ma o tym rozstrzygnąć, już stoi w śladzie —
patrz `fbPostExtras` w `pipeline/facebook.ts` i `auditFbPostExtras`.

**Uwaga od 2026-08-17**: gdyby ktoś wrócił do tego pomysłu, niech najpierw przeczyta
`src/pipeline/repertoire.ts`. Dociąganie stron repertuaru po godzinę idzie dokładnie pod prąd
regule, która je odcina — i z dobrego powodu: repertuar zmienia się co dobę, więc jego bloki
nigdy nie trafiają w cache. Trzy odzyskane godziny nie są warte codziennego pobrania.

### 8b. `posir-poznan`: co po naprawie godzin z URL-a zostało otwarte

Wymyślone godziny (11:46, 15:18, 15:21, 15:25 — z parametru `dates=` widgetu „dodaj do
kalendarza") są **załatwione**: uzasadnienie, pomiar i reguła stoją w nagłówku
`pipeline/extract/calendar-links.ts`, testy w `test/calendar-links.test.ts`. Zasięg zmierzony
przed poprawką: widget ma 1 z 33 pobieranych źródeł, odpowiedników Outlooka i Yahoo nie ma
nigdzie.

Otwarte zostają dwie rzeczy z tej samej strony:

- **Eksport ICS przy każdym wierszu** (`title="Format ICS"`) — gotowe pola KIEDY i GDZIE, bez
  modelu. Uwaga na pokusę, żeby zrobić z tego zamiennik ekstrakcji: **nie jest.** Widać to
  wprost po tym, co ścieżka maszynowa wpisuje dziś w pola ocenne (`from-capability.ts`):
  `tags: ["ical:wydarzenie"]`, `age: openAge()`, `family_friendly: "maybe"`. Taksonomii
  (`dzieci:warsztaty`, `sport:joga`), wieku, rodzinności, `price.free` ani `is_noise` z ICS-a
  nie da się wyczytać, bo to odczyt prozy, nie pól. ICS ma sens jako UZUPEŁNIENIE tam, gdzie
  szkielet jest niepewny (godzina, adres) — model dalej musi przeczytać opis.
  Kontekst: zdolność `rss` tego źródła ma `itemsSeen: 43, datesParsed: 2` i została (słusznie)
  odrzucona, więc dziś idzie ono modelem, choć wystawia obok dane maszynowe.
- **„Całodniowe" nie ma jak dojść do ODBIORCY DIGESTU.** Strona pisze `cały dzień` 14 razy,
  a w naszym modelu danych „nie znamy godziny" i „wydarzenie całodniowe" to ten sam `null`.
  `pipeline/digest/render.ts` pokazuje wtedy wiersz bez godziny, więc odbiorca nie odróżnia
  „godziny nie ma" od „nie znaleźliśmy jej". To ta sama sprawa, co 47 zakresów z nagłówka
  punktu 8, i decyzja jest w `render.ts`, nie w ekstrakcji — chyba że wcześniej dojdzie
  osobne pole na „całodniowe", a wtedy jest też w schemacie.

Ubocznie ten sam pomiar pokazał, że CMS POSIR-u sypie w te parametry szerzej: dwa wiersze mają
KONIEC PRZED POCZĄTKIEM (`20260815T193000/20260802T211500`, `20260829T194500/20260816T213000`).
Godziny są tam przypadkiem poprawne, więc ekstrakcji to nie psuje i reguła ich nie rusza — ale
gdyby kiedyś trzeba było czytać z tych URL-i DATY, tu jest dowód, że bez sprawdzenia spójności
nie wolno.

---

## 9. Pułapki zapisane, żeby ich nie powtórzyć

Nie do zrobienia — do NIEzrobienia. Każda wyglądała na oczywiste ulepszenie.

- **`BROWSER_HEADERS` do Overpass.** Odbija 406 tak samo jak brak nagłówka; wymagany jest UA
  nazywający aplikację. Udawanie przeglądarki jest tu przeciwskuteczne.
- **`(around.<relacja>:R)` w Overpass.** Wygląda na naturalne zapytanie „gminy w promieniu"
  i zwraca **0 elementów po 123 sekundach** — `around` mierzy od węzłów zbioru, a relacja graniczna
  żadnych nie wnosi. Stąd dwa zapytania (bbox + przycięcie u siebie).
- **`[class*=nav]` / `[class*=menu]` przy wycinaniu chromu.** Najlepiej wyglądający wariant ze
  wszystkich: treść poznan.pl −50%, kultura.poznan.pl −40%. Linki do wydarzeń w wyniku: **1 → 0**.
  CMS trzyma listę wyników w kontenerze z „nav" w klasie — to był ładunek, nie opakowanie.
- **`<main>`/`<article>` jako punkt startu.** −58% na oklubon.pl, zero albo wynik ujemny wszędzie
  indziej (tagu brak albo obejmuje cały dokument). Za mało przewidywalne na regułę globalną.

---

## 10. `repeat` nie zna rytmów miesięcznych

Zostało otwarte po sondzie kontenerów (README, „Kontenery: karta listingu, pod którą stoi
program"). Strona `Seniorzy w akcji` wypisuje dwa różne rodzaje rytmu naraz:

```
Nordic walking — poniedziałki 12:00–13:30, Malta            → repeat: "pn"     ✔
Zajęcia plastyczne — II wtorek miesiąca, 16:00, Atlantis     → nie ma zapisu   ✘
Szachy — I środa miesiąca, 11:00, Golęcin                    → nie ma zapisu   ✘
```

Pole `repeat` przyjmuje wyłącznie `codziennie` albo dni tygodnia po przecinku (`prompts.ts`,
`REPEAT_NOTE`), więc „II wtorek miesiąca" nie ma się w czym zmieścić. Model odda wtedy albo
pojedynczy termin, albo rytm tygodniowy — czyli **czterokrotnie za dużo terminów**, a to jest
gorsze od braku wpisu: fałszu z danych już nikt nie wyprostuje (patrz `expandRepeat`).

Czego brakuje przed zmianą: **ile takich rytmów w ogóle jest**. Na dziś znam jeden przykład
z jednej strony — to za mało na nowy kształt pola i na `shared/series.ts`. Pomiar powinien
policzyć w `events.json` wpisy, których tytuł albo `container` niosą „miesiąca" / „co miesiąc",
a które weszły jako pojedynczy termin. Dopóki liczba nie wyjdzie, sonda kontenerów odzyskuje
z takiej strony to, co umie (rytmy tygodniowe), i tyle.

---

## 11. Followupy: „bez bloków" odłożone, zostaje pasek „inne wydarzenia"

Pomysł zgłoszony 2026-08-20: followup to zwykle strona JEDNEGO wydarzenia, więc może w ogóle
nie dzielić followupów na bloki. **Odłożone**, bo pomiar mówi, że dzielił nie ten wymiar co
trzeba — decyduje KSZTAŁT strony, nie to, czy przyszliśmy do niej followupem:

- Rozpad opisu na kawałki naprawia weto tożsamości karty (`selfLinked`, `dom-blocks.ts`) —
  i naprawia je też na stronie źródła, czego „followupy bez bloków" nie tknęłoby.
- Followupy BYWAJĄ listami: `dopiewo.pl/wydarzenia?page=1` (9 wydarzeń), `biblub.com/category/
  aktualnosci/page/1`, `kultura.gmina.pl/category/aktualnosci/page/1`. Trzy z 91 followupów
  w przebiegach 18–20.08 — mało, ale to akurat są PAGINACJE, czyli osobny wątek (niżej).
- Oszczędność z podziału na stronie szczegółów jest w granicach szumu: 3 925 vs ~4 000 tokenów,
  bo prompt systemowy (4 046 zn.) waży więcej niż taka strona.

Wracać do tego, gdy podział zacznie psuć wydarzenie mimo weta tożsamości — wtedy sygnałem
będzie znowu jedno wydarzenie rozpisane na kilka bloków, a nie sam fakt bycia followupem.

### Co z tego ZOSTAJE otwarte: pasek „inne wydarzenia"

Strona szczegółów każdego CMS-a niesie na dole listę sąsiadów i to JEST prawdziwa lista kart
(własne adresy), więc weto tożsamości jej nie tyka — i słusznie. Pomiar z 18–20.08:

- 93 obce ekstrakcje na 31 followupach, po scaleniu 33 unikalne (tytuł + data);
- **17 z 33 wraca na 3–7 różnych podstronach** — to podpis paska. Pozostałe 16 pochodzi
  z followupów, które naprawdę są listami;
- 21 stoi dziś w `events.json` (rejestr: 198), z czego 14 przyszło też listingiem — czyli
  duplikat do rozstrzygnięcia w dedupe — a **7 zawdzięcza rejestr wyłącznie paskowi**;
- jakość: pasek wypełnia **2,39 z 5** pól (godzina, miejsce, miasto, cena, wiek) wobec **3,11**
  dla wydarzeń czytanych z własnej strony;
- **~10 z 198 wpisów rejestru ma `source_url` cudzej podstrony** — digest linkuje „Folklor
  wielkopolski" do strony o wystawie sensorycznej. To jest tu jedyna realna szkoda.

Pieniędzy to nie kosztuje: kafle paska są identyczne na wielu stronach, więc mają wspólny hash
i jadą z cache'u. To defekt JAKOŚCI, nie rachunku — i dlatego rozwiązanie ma być tanie.

**Kandydat: powtarzalność w obrębie serwisu.** Blok stojący na wielu stronach jednego źródła
jest meblem serwisu, nie treścią TEJ strony. Pomiar na żywych followupach (bloki niosące
wydarzenia, „na ≥3 stronach" wobec „tylko na jednej"):

| źródło | stron | wspólnych z wydarzeniami | własnych z wydarzeniami |
|---|---|---|---|
| `okpoznan-wydarzenia` | 17 | **19** | 6 |
| `dopiewo-pl-wydarzenia` | 5 | 3 | 14 |
| `mosina-pl-wydarzenia` | 8 | 1 | 8 |
| `puszczykowo`, `poznan-co-gdzie-kiedy`, `ck-zamek`, `gosir-dopiewo` | 4–6 | **0** | 7–25 |

Odsiew celuje dokładnie w pasek i milczy na czterech serwisach, które paska nie mają. Reguła
ma działać **tylko na followupie**: na stronie źródła ten sam blok JEST treścią i zabranie go
skasowałoby wydarzenie z jedynego miejsca, w którym stoi poprawnie. Wymaga rozszerzenia
`state.blocks` o liczbę różnych stron źródła, na których blok widziano.

Cena: znikną te 7 wydarzeń „tylko z paska". To jest do przyjęcia dopiero z paginacją — dziś
pasek zbiera przypadkiem to, co powinna oddać druga strona listingu.

Odrzucone po drodze: odsiew po klasie (`carousel`, `related`) — słownictwo konkretnego CMS-a,
czyli lista wyjątków w przebraniu; próg text-to-link — pasek jest gęsty od odnośników, ale
karty prawdziwego listingu też (plakat + link), więc próg mierzyłby zastępczo to, co
powtarzalność mierzy wprost.
