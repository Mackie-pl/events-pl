# Otwarte wątki

Rzeczy ustalone w trakcie pracy, których **nie ma gdzie zapisać w kodzie**, bo dotyczą decyzji
jeszcze niepodjętych albo pomiarów, które trzeba powtórzyć. To nie jest lista życzeń — każdy wpis
ma powód i, tam gdzie się dało, liczbę.

Rzeczy JUŻ rozstrzygnięte mieszkają w README i w komentarzach przy kodzie, nie tutaj. Jeśli wpis
stąd zostaje zamknięty, przenieś uzasadnienie do kodu i skasuj go z tej listy.

---

## 1. Decyzja do podjęcia: co z rejestrem

`sources.json` w drzewie roboczym ma **15 źródeł Lubonia** (z `--reset "Luboń" 1`), a w historii
gita leży wersja z **46 źródłami Poznania i okolic**. Są rozłączne — Luboń był w tamtej wersji
opisany innymi wpisami (`lubon-city`, `lubon-ok`, `lubon-biblioteka`).

Trzy wyjścia:
- `git checkout sources.json` → wraca 46, **znika 15 świeżo znalezionych**,
- scalenie obu list (świeże wpisy Lubonia mają proweniencję, stare nie mają jej wcale),
- zostawić 15 i odbudować resztę przez `npm run discover -- "Poznań" 15`.

Dopóki to nie jest rozstrzygnięte, `npm run daily` chodzi po 15 źródłach zamiast po 46, a `--yield`
pokazuje 15 pozycji w sekcji „w rejestrze, bez danych w oknie".

**Uwaga na koszt przy trzecim wariancie:** naprawiony Overpass zwraca dla Poznania +15 km
**20 gmin**, nie 13 (dochodzą Stęszew, Murowana Goślina, Kostrzyn, Kaźmierz, Pobiedziska, Buk,
Granowo). To ~200 zapytań Serpera (budżet 300) i ~20 wywołań Sonneta, rząd **$2-4** za przebieg.

---

## 2. Eval promptów i modeli

Powód, dla którego to jest najwyżej na liście po decyzji o rejestrze: **wszystkie zmiany z sierpnia
2026 poszły w ciemno.** Nowe limity tokenów, structured outputs, wycięty `header` — każda z nich
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
oszczędność z punktu 3. Warto to przewidzieć w projekcie runnera, a nie doklejać potem.

---

## 3. Blok schematu w prompcie jest zdublowany

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

Zablokowane na punkcie 2. **Sam z siebie nie uzasadnia budowy evala.**

---

## 4. Źródła jałowe ze statusem `error`

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

## 5. Profiler entrypointów: dwie wady widziane na żywo

### 5a. Brak werdyktu „archiwalne"

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

### 5b. Menu nawigacyjne udaje listing

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

## 6. `--yield`: czego ten rachunek NIE mierzy

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

## 7. Discovery wpuszcza wszystko

Przebieg dla Lubonia: **15 propozycji, 15 dodanych, zero odrzuceń.** W tym pięć grup FB dla
30-tysięcznego miasta — bo 3 z 10 zapytań w `DISCOVERY_QUERIES` są FB-owe, a `MIN_CONFIDENCE = 0.5`
przepuszcza wszystko od 0.75 w górę.

Tanie ograniczenie, niezależne od jakiegokolwiek pomiaru plonu: limit na gminę i typ przy dodawaniu.
Ale najpierw punkt 6 — może się okazać, że te grupy zarabiają na siebie.

---

## 8. Pułapki zapisane, żeby ich nie powtórzyć

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
