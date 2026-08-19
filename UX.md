# Brief dla projektanta — powierzchnia dla czytelnika

Materiał wyjściowy dla kogoś, kto ma zaprojektować aplikację/webapp na danych z tego repo,
a wcześniej nie miał z nim nic wspólnego.

**Czego tu celowo NIE ma:** ekranów, przepływów, komponentów ani rekomendacji, jak to ma wyglądać.
To jest opis materiału i ograniczeń — decyzje projektowe są do podjęcia, nie do przeczytania.

Wszystkie liczby są **zmierzone na `events.json` z 2026-08-16**: 248 wydarzeń, 35 źródeł, które
w tym przebiegu cokolwiek dały (rejestr ma 83). Za miesiąc trzeba je przemierzyć — plik zmienia
się codziennie.

---

## 1. Czym ten system jest dzisiaj

Potok w Node/TS raz dziennie (cron 6:00) obchodzi 83 źródła — strony gmin, ośrodków kultury,
bibliotek, obiektów sportowych oraz grupy i fanpage'e na Facebooku — wyciąga z nich wydarzenia
modelem językowym i zapisuje **jeden plik: `events.json`**. Poza tym plikiem nie ma żadnego API,
bazy ani backendu.

Istnieją już dwie powierzchnie i warto je znać jako kontekst, nie jako wzorzec:

| co | dla kogo | gdzie |
|---|---|---|
| **digest o 17:00 na Telegramie** — lista „jutro" i „weekend" | właściciel, jedna osoba | `src/actions/digest.ts` |
| **`index.html`** — prosta lista z wyszukiwarką, publikowana na GitHub Pages | ktokolwiek z linkiem | `template.html` |
| *(dla porządku)* **panel** w Angularze — przebiegi, koszty, ślad decyzyjny | operator systemu | `panel/` |

Panel **nie jest** tematem tego briefu. Digest i `index.html` są o tyle istotne, że pokazują,
co dotąd uznano za wystarczające — i że nikt tego nigdy nie projektował.

---

## 2. Do kogo ten system mówi dzisiaj

Nie ma dokumentu z personą, ale potok ma ją wpisaną w decyzje. Cztery ślady:

| decyzja w kodzie | co z niej wynika |
|---|---|
| digest pokazuje „jutro" i „najbliższy weekend"; w piątek sam weekend | horyzont zainteresowania: 1–3 dni |
| półkolonie są usuwane z wyników jako „turnus z zapisami, nie wydarzenie do przyjścia" | chodzi o wyjścia, na które można po prostu przyjść |
| spotkania organizacyjne są usuwane jako „ustalenia przed wydarzeniem, nie samo wydarzenie" | to samo kryterium: liczy się to, na co da się przyjść |
| wydarzenia oznaczone jako rodzinne idą na górę listy; jest filtr wieku dziecka | odbiorcą jest rodzic |
| komisje rady, przetargi i wybory sołeckie są odsiewane jako szum | to nie jest serwis obywatelski |

**To jest hipoteza, nie ustalenie.** Nikt jej nie zweryfikował z użytkownikami — narosła
z tego, że autor budował narzędzie dla siebie. Wolno ją podważyć; trzeba tylko wiedzieć, że
podważenie jej pociąga zmiany w potoku (inny odsiew, inne sortowanie), a nie tylko w interfejsie.

**Zasięg geograficzny:** Poznań 150 wydarzeń, gminy ościenne 78 (Luboń 14, Puszczykowo 13,
Mosina 9, Dopiewo 5, Wiry 4, Komorniki 3, plus kilkanaście wsi po 1–2), bez miejscowości 20.
Aglomeracja, nie miasto.

---

## 3. Materiał: co dokładnie jest w jednym rekordzie

Kompletny słownik pól z pokryciem na 248 wydarzeniach. Kolumna „uwagi" to rzeczy, które widać
dopiero w danych, nie w schemacie.

| pole | pokrycie | co zawiera / uwagi |
|---|---|---|
| `title` | 248 | 36 znaków średnio. **74 tytuły są w całości KAPITALIKAMI** (tak stoi w źródle) |
| `date_start` | 248 | `YYYY-MM-DD`. Zawsze jest |
| `date_end` | 39 | *tylko* „trwa bez przerwy do" — patrz §4 |
| `dates` | 11 | jawna lista terminów serii — patrz §4 |
| `time_start` / `time_end` | 179 / mniej | `HH:MM`. **69 wydarzeń nie ma godziny w ogóle** |
| `venue` | 206 | nazwa miejsca, czasem z adresem, czasem sama („Diament", „Ośrodek Kultury") |
| `town` | 228 | miejscowość; 20 pustych |
| `geo` | 169 | `{lat, lon}` z geokodera — **nie zawsze trafne**, patrz §7 |
| `price` | free=true 43 · kwota 14 · note 25 · **bez werdyktu 188** | trzy pola naraz: `free`, `amount_pln`, `note` (np. „wejściówki do odbioru w bibliotece") |
| `age` | 58 | `{min, max, label}`, gdzie `label` bywa czymkolwiek: „6-9 lat", „seniorzy", „kobiety", „z rodzicem w wodzie", „dla wszystkich" |
| `family_friendly` | true 55 · **„maybe" 133** · false 60 | „maybe" znaczy „model nie wiedział", nie „częściowo" |
| `tags` | 243 mają ≥1 | **172 różne tagi**, zagnieżdżone przez dwukropek (`dzieci:teatr`). Nie jest to ustalony słownik |
| `registration` | 40 | wolny tekst: numer telefonu, „Wiadomość prywatna do…", **albo znacznik `[tel. w źródle]` (18 wpisów)** — patrz §8 |
| `container` | 29 | nazwa wydarzenia-rodzica, z którego rozbito wpis („Wakacyjne kursy pływania na Basenie Rataje") |
| `conditional` | rzadkie | zastrzeżenie ze źródła, np. „przy deszczu przeniesione na 26.07" |
| `sub_slots` | 2 | etapy w ciągu dnia (12–18 dzieci, 18–22 dorośli) |
| `source_url` | 248 | adres ogłoszenia u źródła. **Bywa listą, nie wydarzeniem** (np. `…/kalendarz-wydarzen/`) |
| `source_id` | 248 | identyfikator źródła, np. `ok-lubon-www`, `fb-group-wydarzenia-poznan-3` |
| `origin` | 18 | dla postów z FB: wskazanie oryginału, którego dany wpis jest udostępnieniem |
| `is_noise` | 4 razy true | wpis rozpoznany jako szum urzędowy |

### Trzy prawdziwe rekordy, żeby zobaczyć rozrzut

**Bogaty** (seria z grupy FB, wszystko oprócz godziny):

```json
{ "title": "Wakacyjny kurs pływania – dzieci 3–5 lat", "date_start": "2026-08-17",
  "time_start": null, "venue": "Basen Rataje", "town": "Poznań",
  "price": { "free": null, "amount_pln": null, "note": null },
  "age": { "min": 3, "max": 5, "label": "z rodzicem w wodzie" }, "family_friendly": true,
  "tags": ["sport:pływanie", "dzieci:nauka pływania"],
  "registration": "[tel. w źródle]; [e-mail w źródle]",
  "container": "Wakacyjne kursy pływania na Basenie Rataje",
  "dates": ["2026-08-17", "2026-08-18", … 10 terminów], "geo": { … } }
```

**Ubogi** (i jednocześnie trwający cały miesiąc — takich jest sporo):

```json
{ "title": "SIERPIEŃ W OŚRODKU KULTURY", "date_start": "2026-08-06", "date_end": "2026-08-31",
  "time_start": null, "venue": "Ośrodek Kultury", "town": "",
  "price": { "free": null, … }, "age": null, "family_friendly": "maybe", "tags": [],
  "geo": { "lat": 50.94, "lon": 17.29 } }
```

**Środek stawki** (data, godzina, miejsce — i nic więcej):

```json
{ "title": "Święto Pyry 2026", "date_start": "2026-08-22", "time_start": "11:00",
  "time_end": "14:00", "venue": "Centrum Tradycji i Kultury w Komornikach", "town": "Komorniki",
  "price": { "free": null, … }, "age": null, "family_friendly": true,
  "tags": ["impreza:festiwal"], "source_url": "https://www.gokkomorniki.pl/kalendarz-wydarzen/" }
```

---

## 4. Termin ma trzy różne kształty i nigdy dwa naraz

To jest najważniejsza rzecz do zrozumienia w tych danych — pomyłka tutaj produkuje wydarzenia,
których nie ma, i już raz to zrobiła.

| kształt | jak wygląda | ile |
|---|---|---|
| **jednodniowe** | `date_start`, reszta pusta | ~198 |
| **zakres** | `date_start` + `date_end` — znaczy **„trwa bez przerwy do"** (wystawa, akcja letnia) | 39 |
| **seria** | `date_start` + `dates[]` — jawna lista terminów; `date_end` jest wtedy puste | 11 |

`date_end` **nie jest** końcem serii ani „ostatnim dniem" w ogólnym sensie. Zakres o długości
26 dni znaczy „codziennie przez 26 dni", a nie „gdzieś w tym okresie".

Dwie liczby, które pokazują, czym to jest w praktyce: **2026-08-16 „dzieje się" 93 wydarzenia,
ale 24 z nich to zakresy dłuższe niż tydzień** (wystawy, „Kino na leżakach" przez cały sierpień,
„Akcja Lato z Biblioteką" od lipca). 62 to jednodniówki, z czego 61 ma godzinę.

Dodatkowo `container` (29 wpisów) znaczy, że wydarzenie zostało **rozbite z większego** — jest
elementem cyklu, którego nazwa siedzi w tym polu.

---

## 5. Cykl życia danych — cztery fakty, które ograniczają wszystko

1. **`events.json` jest migawką pisaną co rano od zera.** Nie jest przyrostową bazą.
2. **Wydarzenie nie ma trwałego identyfikatora.** Tożsamością przy scalaniu jest `tytuł+data`
   po normalizacji, która zjada polskie znaki i tnie tytuł do 40 znaków. Rekord z jednego dnia
   nie ma jak zostać rozpoznany jako ten sam nazajutrz.
3. **Nie ma znacznika „widziane po raz pierwszy".** Nie da się dziś powiedzieć, co jest nowe.
4. **Nie ma przeszłości.** Migawka trzyma wyłącznie przyszłość — zero wydarzeń z datą
   wcześniejszą niż dzień generowania. Nie ma też żadnej telemetrii: odsłon, kliknięć, ocen.

Do tego: to samo wydarzenie potrafi z dnia na dzień zmienić `source_id`, bo przy scalaniu
duplikatów z kilku źródeł wygrywa rekord bogatszy w danym przebiegu.

Zasięg czasowy zbioru: dziś i jutro 104 wydarzenia, 7 dni 181, 30 dni 227, wszystko 248
(najodleglejsze 2026-12-11). **73% mieści się w oknie tygodnia** — dalsza przyszłość jest cienka
nie dlatego, że nic się nie dzieje, tylko dlatego, że źródła ogłaszają późno.

---

## 6. Czego w danych nie ma w ogóle

Lista jest krótka i za każdą pozycją stoi konsekwencja, nie kaprys:

- **opisu** — ani zdania. Rekord to tytuł i metadane;
- **zdjęcia ani grafiki** — plakaty istnieją tylko przy źródłach z Facebooka (40 wydarzeń, 16%);
- **organizatora** jako osobnego bytu — jest `venue` (tekst) i `source_id` (nasze źródło);
- **biletów, cen w większości przypadków, dostępności miejsc** — patrz §3;
- **niczego o popularności**: bez telemetrii nie ma „polecanych", „popularnych" ani „bo lubisz";
- **własnej strony wydarzenia** — jedyne „więcej informacji" to wyjście na `source_url`, przy czym
  ten adres bywa listą wydarzeń, a nie konkretnym wpisem.

---

## 7. Gdzie dane bywają nieprawdziwe

Nie chodzi o braki (te są w §3), tylko o wartości, które wyglądają na dobre, a nie są:

- **`geo` potrafi wskazać inne województwo.** 6 z 169 rekordów ma współrzędne poza aglomeracją
  poznańską — „Ośrodek Kultury" bez miejscowości wylądował pod Brzegiem, „Dworek Biesiadny"
  pod Warszawą. Reguła: im uboższa nazwa miejsca i im częściej `town` jest puste, tym mniej warta
  jest pinezka.
- **21 wydarzeń nosi tagi techniczne** (`tribe:wydarzenie`, `jsonld:wydarzenie`) — to nazwy
  formatów, którymi je pobraliśmy, a nie kategorie.
- **`family_friendly: "maybe"` to 54% zbioru** — to jest „nie wiadomo", nie „trochę".
- **Ogon tagów jest jednostkowy**: `taniec:bachata`, `warsztaty:biżuteria`, `sport:żużel` po 2–4
  wystąpienia. Sensowne korzenie to `film` 58, `sport` 48, `dzieci` 39, `warsztaty` 33, `muzyka` 28.
- **Tytuły przychodzą tak, jak stoją w źródle** — z kapitalikami, prefiksami organizatora,
  numeracją edycji („10. LATO Z ESTRADĄ - ŻEGRZE - SEANS KINA PLENEROWEGO - …").

---

## 8. Ograniczenia spoza danych

- **Budżet całego przedsięwzięcia: $15 miesięcznie** i to jest twarda liczba, obejmująca model,
  pobieranie stron i dane z Facebooka. Wszystko, co wymaga nowych wywołań modelu (opisy, lepsze
  tagi, streszczenia), ma cenę i musi zostać policzone przed decyzją.
- **Repozytorium jest publiczne, dane osobowe są redagowane przed zapisem.** Stąd `[tel. w źródle]`
  zamiast numeru w 18 wpisach — projekt nie może obiecywać kontaktu, którego nie wolno nam pokazać.
- **Nie ma backendu i na razie nie ma go w planie.** Dane da się dziś czytać jako statyczny plik
  (`raw.githubusercontent.com`, ~196 kB, otwarty CORS, cache ~5 min) — dokładnie tak robi panel.
  Wszystko, co wymaga kont, synchronizacji między urządzeniami czy powiadomień push, oznacza
  wprowadzenie backendu (rozważany jest Supabase) i jest osobną decyzją właściciela.
- **Dane odświeżają się raz na dobę, rano.** Nie ma nic „na żywo"; odwołane wydarzenie zniknie
  najwcześniej nazajutrz.
- **Jest to projekt jednej osoby w fazie PoC**, budowany pod hasłem „wystarczająco dobrze":
  kompletność rejestru nie jest celem i nigdy nie złapiemy wszystkich wydarzeń.

---

## 9. Napięcia, które projekt będzie musiał rozstrzygnąć

Wypisane jako pytania, bo żadne nie ma tu odpowiedzi — to jest lista rzeczy do zaprojektowania.

1. **Czym dla użytkownika jest „dziś"**, skoro co czwarta pozycja trwa cały miesiąc? Wystawa
   czynna przez sierpień jest równie prawdziwa, co koncert o 18:00, ale nie jest tą samą
   odpowiedzią na to samo pytanie.
2. **Co interfejs robi z niewiedzą?** 76% wpisów bez ceny, 28% bez godziny, 54% bez rozstrzygnięcia,
   czy są dla dzieci. Milczeć, oznaczać, dopytywać u źródła?
3. **Czy „może dla dzieci" pokazywać rodzicowi**, który włączył filtr „dla dzieci"? Pomyłka
   w jedną stronę psuje wyjście, w drugą — ukrywa 133 wydarzenia.
4. **Czy przeglądanie, czy szukanie?** 248 wydarzeń i horyzont tygodnia to mało jak na wyszukiwarkę
   i dużo jak na jedną listę.
5. **Jak wygląda wyjście do źródła**, skoro nie mamy własnej strony wydarzenia, a link czasem
   prowadzi do listy, a nie do konkretnego wpisu?
6. **Czy aplikacja obiecuje cokolwiek trwałego** — zapisywanie, przypomnienia, „nowe od wczoraj"?
   Dziś nie ma na czym tego oprzeć (§5) i jest to zmiana w potoku, nie w interfejsie. Warto wiedzieć,
   ile ta obietnica jest warta, zanim ktoś ją kupi.
7. **Poznań czy aglomeracja?** 60% wpisów to Poznań, ale konkurencyjne kalendarze mają Poznań
   i nie mają Lubonia ani Puszczykowa.
8. **Co robi interfejs w dzień, w którym nic nie ma?** Zdarza się i będzie się zdarzać.

---

## 10. Pytania do właściciela produktu (przed projektowaniem, nie po)

1. Rodzic z małym dzieckiem czy każdy dorosły z wolnym wieczorem? Od tego zależy odsiew w potoku,
   nie tylko układ ekranu.
2. Jedna osoba (dziś: jeden digest na Telegramie) czy publiczny serwis dla wielu odbiorców?
   To jest granica, za którą zaczyna się backend, konta i koszt.
3. Czy wolno wydać pieniądze na wzbogacenie danych (np. jedno zdanie opisu przy każdym wydarzeniu),
   czy projekt ma zmieścić się w tym, co już jest?
4. Aplikacja czy strona? Powiadomienia push są jedyną funkcją, która realnie wymaga aplikacji —
   i jedyną, której dzisiejsze dane nie udźwigną.

---

## 11. Jak obejrzeć te dane samemu

```bash
npx tsx src/actions/digest.ts
```

Wypisuje na ekran dzisiejszy digest — najkrótsza droga do zobaczenia, jak te dane brzmią
złożone w wiadomość. Bez kluczy nic nie wysyła.

Poza tym: `events.json` w korzeniu repo (plik, o którym jest cały ten brief), `index.html`
(dzisiejsza prosta lista, otwiera się w przeglądarce), `README.md` §„Digest" i `src/types/event-schema.ts`
(schemat wraz z instrukcjami, które dostaje model — tam widać, skąd biorą się poszczególne pola).
