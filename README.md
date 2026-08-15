# events-pl — agregator wydarzeń lokalnych (pipeline 2-etapowy, Node/TS, OpenRouter)

## Architektura

```
STAGE 1 (miesięcznie / nowe miasto)         STAGE 2 (codziennie)
─────────────────────────────────           ────────────────────────────────
miasto + promień                            sources.json
  → Overpass API (gminy w promieniu)          → fetch (ETag/304 + hash treści)
  → wyszukiwarka (Serper)                     → bez zmian? wydarzenia z cache, 0 LLM
  → SONNET: triage kandydatów                 → HAIKU: ekstrakcja → JSON
  → sources.json (+ provenance przy źródle)   → followups (1 hop): PDF-y programów,
  → PROFILOWANIE (też --verify solo):           podstrony, plakaty JPG (vision)
    drabina osiągalności (https↔http,        → geocode (Nominatim, darmowe, cache)
      www, 403→headless) → reach              → dedupe (heurystyka + LLM)
    entrypointy: gdzie serwis WYPISUJE        → serie: powtórzenia → jeden wpis z `dates`
      wydarzenia (+ szablon linków, {page})   → events.json → index.html
    zdolności: RSS/WP-REST/tribe/iCal/JSON-LD
    HAIKU: wybór entrypointu albo weto
    dns-dead → dead:true (bez wyszukiwarki!)
    404/500 → search + HAIKU → naprawa
  → discover-runs.json (observability)   src/actions/daily.ts → runs.json + audit.json
src/actions/discover.ts  ·  --why <id> = skąd to źródło      (metryki + ślad decyzyjny)
```

## Pliki

| plik | rola |
|---|---|
| `sources.json` | rejestr źródeł Poznań +15 km (etap 1 wykonany ręcznie 2026-07-20; 46 źródeł, 13 gmin) + `provenance` przy każdym źródle dodanym automatycznie |
| `src/actions/` | wejścia potoku — `daily`, `discover`, `digest`, `backfill-costs`, `probe` (sprawdzenie jednego źródła na żądanie), `panel-server` (lokalny most panelu). Same main() + orkiestracja, zero logiki dziedzinowej |
| `src/adapters/` | wyjścia do świata: `openrouter`, `search` (fasada) + `serper`/`google-cse`/`brave`, `overpass`, `nominatim`, `page-fetch`, `brightdata`, `supabase-archive`, `telegram`, `resend`, `http` |
| `src/pipeline/` | logika dziedzinowa: `discover/` (discovery gmin, walidacja propozycji, `entrypoint`, `capabilities`, `--why`), `verify/` (drabina osiągalności, profil, naprawa URL-i), `extract/` (ekstrakcja, followupy, wydarzenia FB), `digest/`, `dedupe`, `camps` (odsiew półkolonii — turnus z zapisami to nie wydarzenie; jeden filtr przed scalaniem, wspólny dla wszystkich ścieżek), `series` (rytm `repeat` z drutu → terminy, a powtórzenia → jeden wpis z listą `dates`; zwijanie po dedupe, wspólne dla modelu, plakatów, cache'u i kalendarzy), `pii`, `facebook`, `prompts` |
| `src/shared/` | narzędzia bez zależności: `url-template` (zwijanie adresów do szablonów — serce rozpoznania list), `links`, `dates`, `text`, `url`, `hash`, `audit`, `errors`, `json-schema`, `series` (arytmetyka rytmu + etykieta cyklu — jedna implementacja dla digestu i strony) |
| `src/reporting/` | agregaty, koszty, podsumowania Actions, redakcja PII, polityki retencji raportów |
| `src/storage/` | **port składowania** — `DocStore`/`CollectionStore` + implementacja na plikach JSON. Jedyne miejsce znające ścieżki; przejście na bazę to druga implementacja i podmiana wiązań w `storage/index.ts` |
| `src/shared/` | ścieżki, hash, tekst, daty, URL-e, formatowanie błędów + `audit.ts` — zbieracz śladu decyzyjnego (stan modułowy jak liczniki zużycia; w shared/, bo emitują do niego wszystkie warstwy) |
| `src/types/` | typy podzielone po dziedzinach + jedyny barrel w repo (`types/index.ts`). `event-schema.ts` wyłamuje się z „tylko typy" świadomie: to schemat TypeBox, z którego bierze się **naraz** typ `EventItem`, blok schematu w prompcie i `response_format` — jedno źródło prawdy zamiast trzech kopii, które się rozjeżdżały |
| `test/` | testy `node:test` (594 przypadki): pii, url/slug/daty, dedupe (+ raport scalania), ślad decyzyjny, sonda (czyszczenie cache pod `--force`, wyłącznik archiwum), facebook, digest, koszty, retencja, podsumowania, walidacja propozycji |
| `discover-runs.json` | observability etapu 1: każde zapytanie search + wyniki, **każda propozycja modelu wraz z decyzją** (także odrzucenia), geo (Overpass), tokeny/koszt LLM per gmina / źródło / typ zadania (discovery vs weryfikacja); ostatnie 24 przebiegi (szczegóły dla 4 najnowszych) |
| `runs.json` | observability etapu 2: przebieg źródło po źródle (status, HTTP, followupy, tokeny/koszt per zadanie, rekordy Bright Data, ścieżki archiwum) oraz **`produced` — które konkretnie wydarzenia dało źródło w tym przebiegu**, wraz z przegranymi dedupe (`mergedInto`); **ostatnie 7 dni** (min. 2, maks. 30 przebiegów) |
| `audit.json` | **ślad decyzyjny** etapu 2: krok po kroku, źródło po źródle — czemu poszło do modelu albo z cache, co ucięto na limicie followupów, które wydarzenie odrzucono i dlaczego, co przegrało scalanie. Zamknięty słownik kroków (`src/types/audit.ts`), notka po polsku + detale. Kroki `llm` niosą też
rachunek za to konkretne wywołanie (`usd`, `tokIn`, `tokOut`) i ścieżkę promptu w archiwum
(`archive`) — koszt per źródło jest w `runs.json`, ale „które z pięciu wywołań kosztowało" widać
tylko tutaj. Ta sama retencja co `runs.json` (7 dni), ~46 kB na przebieg. Panel pobiera go **dopiero na stronie źródła** — nie przy wejściu |
| `costs.json` | księga wydatków obu etapów: linia na (przebieg × kategoria) z wolumenem, stawką i najdroższymi pozycjami; 90 dni. Zasila zakładkę **Money** |
| `eslint.shared.js` | wspólne progi rozmiaru dla potoku i panelu (max 350 linii kodu na plik, 120 znaków na linię) — pilnowane przez `ci.yml` |
| `template.html` | frontend (wiek dziecka, tagi zagnieżdżone, weekend, mapa OSM); `reporting/render-index.ts` wstrzykuje JSON |
| `panel/` | panel observability (Angular 22 + Taiga UI): **Day** (przegląd dnia → source runs → eventy + ślad decyzyjny + iframe podglądu + **Check now**: sonda jednego źródła na żądanie, przy działającym `npm run panel-server`), **Discovery** (proweniencja rejestru → przebiegi discover) i **Money** (wydatki dzień po dniu wg kategorii); deploy na GH Pages pod `/panel/` przez `deploy-pages.yml` (Settings → Pages → Source: GitHub Actions) |

## Setup

```bash
npm install                     # Node >= 22; playwright jest opcjonalny
# strony JS-only (CK Zamek itp.):
npm install playwright && npx playwright install chromium

cp .env.example .env            # (PowerShell: copy .env.example .env) → uzupełnij klucze
npm run daily                   # → events.json + index.html

# raz w miesiącu / nowe miasto (wymaga SERPER_API_KEY w .env):
npm run discover -- "Poznań" 15 # pełne discovery + weryfikacja URL-i
npm run discover -- --verify    # sama weryfikacja/naprawa URL-i (tanio: Haiku; cron w discover.yml)
npm run discover -- --why lubon-ok   # skąd to źródło się wzięło (nie kosztuje nic, nie rusza sieci)
npm run discover -- --yield          # co byśmy stracili, zdejmując źródło (też darmowe, z runs.json)
npm run discover -- --reset "Poznań" 15   # kasuje rejestr i odbudowuje go z samych trafień
                                          # wyszukiwarki; raport pokazuje, co NIE wróciło

npm run typecheck               # tsc --noEmit (strict)
npm test                        # testy kodu — muszą być zielone
npm run test:live               # testy kontraktowe na danych z repo (patrz niżej)

# structured outputs (wymuszony JSON Schema na odpowiedzi) — od 2026-08-01 domyślnie WŁĄCZONE.
# Obsługa zależy od modelu I od tłumaczenia OpenRoutera, więc po zmianie MODEL_EXTRACT:
npm run check:structured        # PŁATNE (~$0.004): mówi, czy MODEL_EXTRACT przyjmuje schemat
# jeśli odbija → STRUCTURED_OUTPUTS=0 w .env (potok i tak gasi flagę sam po odbiciu)
```

**Konfiguracja idzie przez `.env`** (wzór w `.env.example`, plik jest w `.gitignore`; pełna
lista pokręteł: [Parametry konfiguracji](#parametry-konfiguracji)).
Skrypty `npm run …` wczytują go same — `node --env-file-if-exists`, bez `dotenv` i bez
zależności od powłoki. To istotne na Windowsie: `VAR=... npm run x` i `export VAR=...`
to składnia bash-a, **w PowerShellu nie działa** (`... is not recognized as a name of a cmdlet`).
Gdybyś jednak chciał ustawić zmienną doraźnie, bez `.env`:

```powershell
$env:OPENROUTER_API_KEY = "sk-or-..."   # PowerShell
```
```bash
export OPENROUTER_API_KEY=sk-or-...     # bash / zsh
```

Na GitHub Actions `.env` nie istnieje — te same nazwy przychodzą z repo secrets, dlatego
flaga to `--env-file-if-exists`, a nie `--env-file` (ta wywaliłaby się przy braku pliku).

Wymagania dla MODEL_EXTRACT: obsługa obrazów (plakaty) + solidny JSON po polsku. Struktura `src/adapters/openrouter.ts`
to czysty fetch do OpenRouter chat completions — zero vendor lock-in.

## GitHub Actions (darmowy hosting + cron)

`.github/workflows/daily.yml`:
```yaml
name: daily-events
on:
  schedule: [{cron: "0 4 * * *"}]     # codziennie 6:00 PL
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: {node-version: 22}
      - run: npm ci
      - run: npx playwright install --with-deps chromium   # źródła headless + fallback po 403
      - run: npm run daily
        env: {OPENROUTER_API_KEY: "${{ secrets.OPENROUTER_API_KEY }}"}
      - run: |                        # publikacja na GitHub Pages / do repo
          git config user.name bot && git config user.email bot@users.noreply.github.com
          git add events.json index.html state.json
          git commit -m "daily $(date +%F)" && git push
```

## Koszty: księga `costs.json` + zakładka **Money** w panelu

Szacunek z tabeli niżej to plan. **Rachunek to co innego** — dlatego każdy przebieg dopisuje
do `costs.json` po jednej linii na kategorię wydatku, a panel rysuje z tego wydatki dzień po
dniu. Pytanie „czemu drożej niż zakładałem" ma trzy warstwy odpowiedzi, bo trzy różne rzeczy
mogą pójść nie tak:

| warstwa | gdzie | odpowiada na |
|---|---|---|
| **kwota dzienna** | wykres w zakładce Money | *kiedy* zaczęło być drożej |
| **kategoria** | serie wykresu (tekst / plakaty / discovery / verify / FB / infra) | *co* podrożało — plakat i tekst to ten sam Haiku w rachunku, ale rosną z innych powodów |
| **pozycja** | tabela „najdroższe pozycje" (`top` przy wpisie) | *gdzie* — konkretne źródło albo gmina |

**Kategorie i skąd biorą się kwoty:**

| kategoria | co kupujemy | kwota |
|---|---|---|
| `llm-extract` | Haiku: treść stron i PDF-ów | od OpenRoutera (`usage.cost` przy każdym wywołaniu) |
| `llm-vision` | Haiku multimodal: plakaty JPG/PNG | j.w. |
| `llm-discover` | Sonnet: triage kandydatów (etap 1) | j.w. |
| `llm-verify` | Haiku: naprawa martwych URL-i | j.w. |
| `fb` | Bright Data: rekordy wydarzeń i postów grup | **szacunek**: `rekordy × BD_COST_PER_RECORD` |
| `search` | wyszukiwarka: zapytania | **szacunek** (Serper: 2500 gratis, dalej `SEARCH_COST_PER_QUERY`, domyślnie $0.001) |
| `scrape` · `geo` · `storage` | pobrania HTTP, Nominatim, Supabase Storage | **szacunek** (dziś 0) |

Kategorie o stawce zero **też są zapisywane**, z wolumenem. Darmowy tier to koszt zero
*do limitu*: bez zapisanego wolumenu pierwszy rachunek za przekroczenie (albo pierwszy ban
od Nominatima) nie ma z czym się skonfrontować. Panel rysuje je łącznie jako „infra"
i rozbija w tabeli. Szacunki są w panelu i w logach znaczone `~` — **stawka razy wolumen
nigdy nie awansuje po cichu na kwotę od dostawcy**.

```bash
npm run backfill-costs          # odtworzenie księgi z runs.json / discover-runs.json
npm run backfill-costs -- --force   # także dla przebiegów już policzonych
```

Backfill ma jedno ograniczenie zapisane wprost w danych: przebiegi sprzed podziału na
zadania nie wiedzą, ile kosztowały plakaty — ich koszt ląduje w całości w `llm-extract`
z flagą `inferred`, a panel to zaznacza, zamiast udawać pomiar.

Stawki i budżet ustawiasz w `.env` (`COST_MONTHLY_BUDGET_USD`, `BD_COST_PER_RECORD`, …);
księga zapisuje stawkę obowiązującą w momencie przebiegu, więc zmiana cennika nie
przepisuje historii. **Poza księgą zostaje jedno**: minuty GitHub Actions — publiczne repo
ma je bez limitu, więc cron i Pages nie generują pozycji (panel mówi to wprost).

## Szacunek (ceny 07.2026: Haiku 4.5 $1/$5, Sonnet $3/$15 za MTok; batch −50%, cache −90%)

**Dziennie (etap 2, 46 źródeł):**

| scenariusz | wejście | wyjście | koszt/dzień | koszt/mies |
|---|---|---|---|---|
| naiwny (wszystko codziennie) | ~350k tok | ~75k tok | $0.73 | ~$22 |
| **+ diff hash** (≈30% stron zmienia się dziennie) + followupy | ~130k | ~30k | $0.28 | ~$8.50 |
| + prompt caching + **Batch API** (−50%) | — | — | **$0.12** | **~$3.60** |

**Miesięcznie (etap 1):** 1 przebieg discover, ~13 gmin × 7 zapytań, triage Sonnetem ≈ **$2–4/przebieg**.

**Pozostałe:** geocoding Nominatim 0 zł (cache + 1 req/s), hosting GH Pages 0 zł, cron GH Actions 0 zł.
Plakaty JPG: ~10/dzień × ~1.5k tok obrazu ≈ $0.02/dzień.
Opcjonalnie FB przez Bright Data (sekcja niżej): rozliczenie per-rekord, rząd ~$1–1.5/1000 rekordów → ~$5–10/mies.

### Suma: **~$6–15/mies** (bez FB ~$6, z FB ~$15). Discovery wliczone.

## Facebook przez Bright Data (opcjonalne)

Włączane sekretem `BRIGHTDATA_API_KEY` (GitHub → Settings → Secrets albo `.env` lokalnie). Bez niego
cały pipeline działa jak dotąd, a źródła FB są raportowane jako `skipped-fb` (tryb zero-cost).
Dwie funkcje (`src/adapters/brightdata.ts` + `src/pipeline/facebook.ts`):

1. **Rozwiązywanie linków do wydarzeń FB** — `facebook.com/events/<id>` znalezione na stronach źródeł,
   w followupach ekstraktora i w postach grup są zbierane i zbiorczo zamieniane w `EventItem`
   (Bright Data *Facebook Events*, dataset `gd_m14sd0to1jz48ppm51`; mapowanie strukturalne, bez LLM).
   Wynik per-link trafia do cache w `state.json` (`fb-event:<url>`, TTL 7 dni) — znany link nie kosztuje
   rekordu drugi raz, a wpisy po zakończonych wydarzeniach są usuwane. Przy 304 strony źródłowej linki
   wracają ze stanu (`fbUrlsBySource`), więc wydarzenia nie znikają. Limit na przebieg:
   `BD_MAX_FB_EVENTS` (domyślnie 40) — bezpiecznik kosztów.
2. **Otwarte grupy FB jako źródła** — `fetch:"fb_group"` (`type:"fb_group"`): posty grupy pobierane
   przez Bright Data (*Facebook Posts by group*, dataset `gd_lz11l67o2cb3r0lkj3`), spłaszczane do
   tekstu i dalej traktowane jak zwykła strona: diff po hashu, cache ekstrakcji, followupy, wiersz
   w raporcie przebiegu. Surowe posty lądują wyłącznie w prywatnym archiwum (`archiveRaw`, id `__bd`),
   nie w repo — to treści z danymi osobowymi. Linki do wydarzeń z postów zasilają pulę z pkt 1.

   **Blok = post.** To jedyne źródło, które przychodzi już podzielone, więc granicy nie zgadujemy:
   `Fetched.blocks` niesie gotowy podział (`fbGroupPostsToBlocks`), a `segment()` w ogóle się nie
   odzywa. Podział po akapitach przecinał post między tytuł a datę w 142 z 356 przypadków
   (2026-08-14) — po zmianie w żadnym, przy tej samej liczbie wywołań modelu. Niezmiennik:
   `blocks.join()` musi dawać `text` co do znaku, bo z `text` liczy się hash źródła i dowód
   bezpiecznika. Krok śladu `block` mówi wtedy „podział: posty (N)".

   **Udostępnienia (`original_post`).** Pomiar z 2026-08-14 (221 postów, 14 grup): 43% wpisów to
   udostępnienia cudzego ogłoszenia, a termin siedzi WYŁĄCZNIE w oryginale w 31.6% z nich —
   przypadek odwrotny (termin tylko w podpisie udostępniającego) nie wystąpił ani razu poza
   oryginałami bez tekstu. Dlatego spłaszczanie dokleja treść oryginału pod podpisem (nie zamiast:
   oryginał bywa pusty), z nagłówkiem `UDOSTĘPNIONE OGŁOSZENIE (autor, data)`. Nagłówek niesie datę
   PUBLIKACJI, więc `extract/date-hint.ts` wycina go z dowodu na termin. Tożsamość oryginału
   (`EventItem.origin`) jest osobnym przejściem dedupe — patrz niżej. Krok śladu: `fb.group`.

   **Każda treść raz.** Udostępniając, ludzie zwykle WKLEJAJĄ ogłoszenie, zamiast je komentować —
   i wtedy doklejenie oryginału mówi wszystko dwa razy. Pomiar na archiwum 2026-08-15 (198 postów,
   15 grup, 75 udostępnień z treścią oryginału): 42 podpisy (56%) były zawarte w oryginale albo
   jego nadzbiorem, 12 959 z 18 777 znaków podpisów nie wnosiło nic; pozostałe 33 podpisy są własne
   (31 nie ma z oryginałem ani jednej wspólnej linii). Dlatego `fbShareShape` porównuje obie strony
   postu „po literach" (NFKC, bez emoji i interpunkcji — udostępniający wkleja z własnym zdobieniem)
   i zostawia tę, która jest nadzbiorem; przy równości oryginał, bo jego nagłówek niesie autora
   i datę. Odsiew idzie po ZAWIERANIU, nie po „jest udostępnieniem". Efekt na całym dniu: −6.9%
   znaków do modelu. Krok śladu `fb.group` (`fbShareStats`) liczy oba kierunki osobno — `onlyCaption`
   rosnące ponad pojedyncze przypadki znaczyłoby, że wycinamy oryginały, czyli stronę z ogłoszeniem.

**Discovery (etap 1)** dokłada zapytania `site:facebook.com/groups {town}` i `{town} grupa facebook
wydarzenia lokalne`; model triage'u zwraca otwarte grupy jako `fb_group`. Zamknięte grupy /
kupię-sprzedam są odrzucane.

**Rytm grupy i grupy niedostępne.** Limit `limit_per_input` jest dziś jedną stałą (50) dla każdej
grupy, a rozliczenie idzie per-rekord — więc wioskowa grupa z jednym postem na tydzień kosztuje
tyle samo, co poznańska z dwustoma dziennie, i obie oddają równo 50 rekordów. Każde pobranie mierzy
więc rytm publikacji (`SourceRun.fbGroup`: `posts` vs płatne `records`, `newest`/`oldest`, `spanDays`,
`postsPerDay`, `atLimit`) i zapisuje go w `runs.json` oraz w śladzie jako krok `fb.group`. Pomiar
**niczym jeszcze nie steruje** — jest wejściem do przyszłego limitu liczonego osobno dla każdej grupy.

Sonda 2026-08-11 (`fb-group-allin-poznan`, `limit_per_input=5`, koszt $0.0075) rozstrzygnęła rzecz
nieudokumentowaną u dostawcy: **`limit_per_input` oddaje NAJNOWSZE posty, malejąco po `date_posted`**
(5 rekordów z jednego dnia, 13:03 → 09:22), więc liczenie limitu z tempa ma sens. Ta sama sonda
pokazała pułapkę metody: okno krótsze od doby trafia w godziny szczytu i **zawyża** tempo
(3.7 godziny → 32.6 postów/dobę, choć noc nic nie publikuje). Wiarygodne są okna ≥1 doby — przy
limicie 50 okno takiej grupy to ~1.5 doby, czyli akurat.

Osobno działa reguła na grupy niedostępne: przy `include_errors=true` grupa prywatna/usunięta oddaje
jeden **płatny** wiersz błędu zamiast postów — codziennie, w nieskończoność (2026-08-11: trzy z 23 grup).
Po `FB_GROUP_BLOCKED_LIMIT` (3) takich pobraniach z rzędu daily pomija źródło ze statusem
`skipped-blocked`, a co `FB_GROUP_BLOCKED_RECHECK_DAYS` (14) puszcza jedną sondę — grupy bywają
otwierane z powrotem i bez sondy nie miałby tego kto zauważyć. Jeden post z jakiegokolwiek pobrania
zeruje licznik (liczy się SERIA, nie historia), a zero rekordów **nie** jest karane: to awaria po
stronie Bright Data, nie dowód na grupę. Świadomie osobny status od `skipped-inactive` — tamto znaczy
„discovery przestało znajdować adres" i naprawia je wyszukiwarka, to znaczy „adres jest, scraper się
do niego nie dostaje". Patrz `src/pipeline/extract/fb-group-blocked.ts`.

**Limit liczony per grupa.** Zamiast jednej stałej 50 dla wszystkich, `limit_per_input` wylicza
regulator z POKRYCIA: czy to, co wróciło, sięgnęło wstecz aż do poprzedniego pobrania. Limit
niewyczerpany → schodzimy do tego, co realnie leży; wyczerpany, a okno pokrywa przerwę z zapasem
→ schodzimy; wyczerpany i okno krótsze niż przerwa → podnosimy, bo treść ucieka. Świadomie **nie**
wprost z `postsPerDay`: ta liczba przy krótkim oknie jest zawyżona (patrz wyżej), a regulator
z zawyżonego wejścia kupuje rekordy, których nikt nie potrzebuje. Sufit `FB_GROUP_LIMIT_MAX`
jest domyślnie równy dotychczasowej stałej (50), więc mechanizm może wydatek wyłącznie
**zmniejszyć** — pętla sama podnosząca limit u dostawcy per-rekord to dokładnie kształt awarii
z 2026-08-10. Patrz `src/pipeline/extract/fb-group-limit.ts`.

**Próg opłacalności.** Brutto plon grupy nie mówi nic o jej wartości: poznańskie grupy powielają
w większości to, co i tak stoi na stronach domów kultury. Liczy się `novel` — wydarzenia, których
nie dało **żadne źródło spoza FB** — i `usdPerNovel = costUsd / novel`. Rachunek per grupa trafia
do `RunReport.fbValue`, do job summary jako tabela „Wartość kanału FB" i na stdout jedną linią.
Po ustawieniu `FB_MAX_USD_PER_EVENT` źródła powyżej progu są wyciszane jako `skipped-costly`.

Cztery bezpieczniki, bo pomyłka kasuje źródło, nie wiersz w raporcie: (1) **bez zmiennej mechanizm
nie działa** — wycena wydarzenia jest decyzją właściciela, nie stałą w kodzie; (2) `FB_YIELD_MIN_RUNS`
(5) realnych pobrań, zanim cokolwiek zapadnie — pominięte przebiegi się nie liczą; (3) wyciszenie
wygasa po `FB_MUTE_DAYS` (30) i źródło wraca samo do pomiaru, a poprawa zdejmuje je wcześniej;
(4) **podłoga obsady gminy** `FB_MIN_SOURCES_PER_TOWN` (1).

Podłoga jest tu najważniejsza, bo naprawia wadę samej miary, a nie jej implementacji. Ranking
kosztowy układa się wzdłuż granicy administracyjnej, nie jakościowej: ten sam koszt rekordów
dzieli się w gminie wiejskiej przez kilka wydarzeń, a w Poznaniu przez pięćdziesiąt, więc pomiar
2026-08-12 daje $0.0023–0.0026 wyłącznie dla grup poznańskich i $0.04–0.09 wyłącznie dla
Puszczykowa, Lubonia i Dopiewa. Próg bez podłogi zdjąłby najpierw te gminy, dla których serwis
powstał, i zrobiłby z niego agregator samego Poznania. Podłoga gwarantuje, że gmina nie straci
całej obecności na FB — ratowane jest **najtańsze** z pozostałych źródeł gminy (werdykt
`town-floor`, osobny od `keep`: źródło JEST za drogie, tylko cena wycięcia gminy jest wyższa).
Grupy niedostępne dla scrapera nie obsadzają gminy i nie są ratowane — inaczej jedna prywatna
grupa „zajmowałaby" miejsce i pozwalała wyciszyć jedyną działającą.
`novel === 0` przy spełnionym minimum jest traktowane jak przekroczenie progu, nie jak brak danych.
Świadomie **nie** to samo co `exclusive` z symulacji zdejmowania: dwie grupy niosące to samo
wydarzenie spoza sieci mają `exclusive: 0` obie i próg postawiony na tamtej mierze wyciszyłby obie.
Patrz `src/pipeline/extract/fb-cost-mute.ts`.

**Przełączniki env** (wszystkie opcjonalne) — grupy `fb` i `costs` w tabeli
[Parametry konfiguracji](#parametry-konfiguracji).

**Liczenie kosztu.** Bright Data rozlicza per-rekord. Każdy przebieg z FB dopisuje linię do
`brightdata-usage.jsonl` (commitowany) i loguje na stdout: `triggers · inputs (URL) · records · polls ·
errors`; pole `brightdata` trafia też do `events.json`. Linia zawiera `snapshots` (snapshot_id każdego
triggera) — Bright Data trzyma snapshoty ~30 dni, a ponowne pobranie jest darmowe, więc surowe dane
każdego przebiegu da się odtworzyć bez płacenia. Koszt ≈ `records × stawka_za_rekord` (potwierdź
w panelu Bright Data). Przykład analizy: `cat brightdata-usage.jsonl | jq`.

## Digest (17:00): Telegram (aktywny) / email (w zapasie)

`src/actions/digest.ts` + workflow `digest.yml` (cron 15:00 UTC = 17:00 CEST; zimą zmienić na 16).
Logika dni: **pt** → sam WEEKEND (sob+nd) · **sob** → tylko JUTRO (nd) · **nd–czw** → JUTRO + najbliższy WEEKEND.
Rodzinne 👨‍👦 na górze; szum (komisje itp.) odfiltrowany. Kanały niezależne — aktywny każdy, który ma ustawione env.

**Telegram (2 minuty setupu):**
1. Napisz do [@BotFather](https://t.me/BotFather) → `/newbot` → skopiuj token → secret `TELEGRAM_BOT_TOKEN`.
2. Napisz cokolwiek do swojego nowego bota (musisz zacząć konwersację!).
3. Otwórz `https://api.telegram.org/bot<TOKEN>/getUpdates` → pole `message.chat.id` → secret `TELEGRAM_CHAT_ID`.

Wiadomości: HTML, po jednej na sekcję (JUTRO / WEEKEND), auto-cięcie przy limicie 4096 znaków.

**Email (Resend, uśpiony):** odkomentuj env w `digest.yml` + secrets `RESEND_API_KEY`
([resend.com](https://resend.com) — 100 maili/dzień za darmo, wysyłka z `onboarding@resend.dev`) i `DIGEST_TO`.

Wspólne: `DIGEST_CHILD_AGE=5` — filtr wg wieku dziecka. Bez żadnych kluczy `npm run digest` robi dry-run na stdout.

## Etap 1 jako profiler źródła

`Source` nie jest adresem, tylko **profilem**: gdzie wchodzić, czym pobierać i co serwis oddaje
maszynowo. Wszystkie trzy pytania rozstrzyga się raz, przy discovery — nie co rano.

**Drabina osiągalności** (`pipeline/verify/reach.ts`) zamiast jednej sondy i jednego boola.
Jeden probe mieszał ze sobą diagnozy wymagające przeciwnych napraw — pomiar na rejestrze z lipca 2026:

| objaw | co to naprawdę znaczy | co robi drabina |
|---|---|---|
| `ENOTFOUND` | domena nie istnieje | `dead: true` **od razu, bez wyszukiwarki** |
| `certificate has expired` | serwis żyje, TLS nie | próba `http://`, potem `www` |
| `HTTP 403/429` | anty-bot, treść jest | jedna próba przez przeglądarkę → `fetch: "headless"` |
| `HTTP 404/500` | serwer żyje, zasobu nie ma | naprawa przez search + Haiku |
| 200, ale <500 B | parking/zaślepka | jak wyżej |

**Entrypointy** (`pipeline/discover/entrypoint.ts`) — adres, pod którym serwis WYPISUJE wydarzenia.
Wchodzenie codziennie przez stronę główną oznaczało podawanie modelowi menu i banera cookies,
podczas gdy lista siedzi pod stałym `/aktualnosci`. Rozpoznanie jest algorytmiczne: odnośniki
z korzenia punktowane po ścieżce i kotwicy → pobranie kilku najlepszych → **gęstość listy**
(`shared/url-template.ts`: ile odnośników zwija się do jednego szablonu, np. `/wydarzenia/{slug}`)
→ jedno tanie wywołanie Haiku, które wybiera albo mówi „to nie jest strona z wydarzeniami"
(`ENTRYPOINT_LLM=always|ambiguous|never`).

**Zdolności** (`pipeline/discover/capabilities.ts`) — RSS, WP REST, The Events Calendar, iCal, JSON-LD.
Reguła zapisu brzmi: **liczy się pobranie, nie istnienie endpointu**. Na żywych serwisach
The Events Calendar odpowiadał `{"total":0}`, Modern Events Calendar `[]`, a WP REST z typem `event`
oddawał wpisy bez terminu (`acf: []`) — wszystkie trzy przeszłyby test „zwraca 200". Stąd
`itemsSeen` i osobno `datesParsed`; data publikacji wpisu się nie liczy.

Rozpoznanie na 15 serwisach: **zero JSON-LD `Event`, zero `<time datetime>`, zero microdanych** —
dlatego ekstrakcja modelem zostaje, a sonda zdolności jest szukaniem wyjątków, nie regułą.

## Observability etapu 1: dlaczego ten adres jest na liście?

Rejestr źródeł buduje model na podstawie wyników wyszukiwarki, więc po miesiącach nikt nie pamięta,
skąd wziął się konkretny adres i czy w ogóle kiedykolwiek odpowiedział. Odpowiedź składa się z trzech
warstw, celowo rozdzielonych — każda przeżywa co innego:

| warstwa | gdzie | co odpowiada | żywotność |
|---|---|---|---|
| **proweniencja** | `sources.json` → `source.provenance` | zapytanie → wynik wyszukiwarki (tytuł/URL/opis) → model + confidence + jednozdaniowe uzasadnienie → **wynik pierwszego pobrania** | póki źródło jest w rejestrze |
| **ledger propozycji** | `discover-runs.json` → `towns[].proposals[]` | co model zaproponował i co z tym zrobiliśmy: `added` / `duplicate` / `low-confidence` / `invalid` + powód | 24 przebiegi (szczegóły: 4 najnowsze) |
| **prompt i odpowiedź** | prywatne archiwum (Supabase) | co dokładnie model dostał i co zwrócił, 1:1 | `ARCHIVE_RETENTION_DAYS` |

Ledger jest tu równie ważny jak proweniencja: **„model tego nie zaproponował" i „zaproponował, a my
odrzuciliśmy przy progu confidence" wymagają zupełnie różnych napraw**, a bez zapisu odrzuceń wyglądają
identycznie (jedna liczba `proposed`).

```bash
npm run discover -- --why lubon-ok        # id, fragment URL-a albo fragment nazwy
```

wypisuje wpis rejestru, proweniencję (zapytanie + trafienie + uzasadnienie modelu), wynik pierwszego
pobrania (`HTTP 200 · text/html · 12 340 zn. · 240 ms`), całą historię weryfikacji URL-a z przebiegów
oraz — jeśli adresu w rejestrze **nie ma** — wszystkie propozycje z nim związane wraz z powodem
odrzucenia. To samo w panelu: zakładka **Discovery** (rejestr z kolumną „why", rozwijane szczegóły
i przejście do przebiegu).

**Plon marginalny (`--yield`).** Proweniencja mówi, SKĄD źródło jest; plon mówi, czy zasługuje na
miejsce. Rejestr rośnie monotonicznie, a discovery dla jednej gminy potrafi dodać pięć grup FB
o w większości tych samych imprezach — „ile wydarzeń dało źródło" nie jest tu miarą wartości.
Liczy się, ile dało wydarzeń, **których nie dało nic innego**:

```bash
npm run discover -- --yield        # liczy z runs.json: zero sieci, zero kosztu
```

Nośnikiem jest `SourceRun.produced` — stan **przed** dedupe, jedyne miejsce, w którym widać rekordy
przegranych; po scaleniu duplikat znika i „nikt inny tego nie miał" przestaje być odróżnialne od
„mieli wszyscy". Tożsamość wydarzenia bierzemy z `shared/event-key.ts`, tej samej funkcji, którą
scala potok — własna normalizacja mierzyłaby nakładanie inne niż to, które faktycznie zaszło.

Raport rozdziela dwie diagnozy, które w symulacji wyglądają identycznie (obie „można zdjąć za darmo"),
a wymagają przeciwnych działań: **redundantne** (dają wydarzenia, ale wszystkie ma ktoś inny — nadmiar
do usunięcia) i **jałowe** (nie dają nic — zwykle usterka do naprawy). Pierwszy pomiar na 5 przebiegach
i 46 źródłach: **zero redundantnych**, 25 jałowych za $0.74 na przebieg. Nakładanie istnieje
(komorniki-city ↔ komorniki-gok mają 19 wspólnych wydarzeń), ale każde źródło ma też coś wyłącznie
swojego — cały wydatek bez pokrycia siedzi w źródłach, które nie dają nic.

⚠️ Rachunek jest w JEDNĄ stronę ostrożny i w jedną nie: klucz scalania obcina tytuł do 40 znaków bez
znaków specjalnych, więc „Fiesta" i „Fiesta 2026" liczą się osobno — **nakładanie jest zaniżone**,
wyłączność zawyżona. Źródło, które mimo to wyszło na zbędne, jest zbędne tym pewniej. Nie mierzymy
też utraty WYPRZEDZENIA: kto publikuje pierwszy, a resztę i tak dopisują inni, wyjdzie tu na zbędnego.

⚠️ 46 źródeł z ręcznego etapu 1 (2026-07-20) proweniencji nie ma. Do niedawna nie miało też szans jej
dorobić: trafienie w znany adres kończyło się `decision: "duplicate"` i `continue`, więc rejestr nigdy
nie dowiadywał się, że nadal jest znajdowany. Teraz są dwie drogi wyjścia — `confirm()` dopisuje
proweniencję każdemu adresowi, który discovery znajdzie ponownie, a `--reset` odbudowuje rejestr
wyłącznie z trafień wyszukiwarki i wypisuje, czego nie dało się odtworzyć.

**Rozliczanie rejestru.** Pełny przebieg nie tylko dodaje — także sprawdza, czego wyszukiwarka już
NIE znajduje. Reguła jest asymetryczna z premedytacją: **degradacja za brak dowodu, śmierć tylko za
dowód**. Brak trafienia zwiększa `missedRuns`; dopiero dwa pudła z rzędu PRZY zerowym plonie w oknie
`runs.json` ustawiają `inactive: true` (daily pomija jako `skipped-inactive`). Powrót jest
automatyczny — pierwsze trafienie zdejmuje flagę. Źródła FB są wyłączone z tej reguły (Google nie
indeksuje grup, a `verify` i tak ich nie dotyka), a plon ma weto także wobec werdyktu `dead`:
źródło, które w oknie `runs.json` dało wydarzenia, nie zostanie pochowane przez nieudaną sondę.

### Testy kontraktowe na żywych danych (`npm run test:live`)

`test/live/*.live.ts` czyta to, co faktycznie leży w repo po ostatnim przebiegu, i pilnuje reguł,
których potok ma dotrzymywać: martwe źródło z działającą zdolnością, `inactive` mimo plonu,
entrypoint na innym hoście niż źródło, naprawa zgłoszona w raporcie, ale niezapisana w rejestrze.

Zasada, dla której powstały: **danych nie poprawiamy ręcznie.** Gdy w rejestrze widać sprzeczność,
nie edytujemy `sources.json` — piszemy asercję, która ją nazywa, i zmieniamy potok tak, żeby następny
przebieg wyprodukował dane poprawnie. Każdy komunikat porażki kończy się linią `POTOK:` z konkretną
propozycją zmiany, właśnie po to, żeby nie kusiło do edytora.

Dlatego to osobny skrypt, a nie część `npm test`: `npm test` waliduje KOD i musi być zielony,
`test:live` waliduje STAN DANYCH i ma prawo świecić na czerwono aż do najbliższego przebiegu.
Czyta drzewo robocze, więc na nieaktualnym klonie odpowie o nieaktualnym stanie.

**Twardość przebiegu** (etap 1 kosztuje realne pieniądze, więc awaria nie może kasować wyniku):

- raport i zmiany w `sources.json` zapisują się **także po wyjątku** (`partial: true` + `err` w raporcie);
  wyjątek przy naprawie jednego źródła nie przerywa weryfikacji pozostałych,
- wyszukiwarka: błąd trwały wyłącza ją na resztę przebiegu (wcześniej limit wyglądał jak „brak wyników").
  Rozpoznanie „trwały czy potknięcie" zna tylko dostawca i każdy mówi to inaczej — Serper polem
  `message` przy 402/403, Google w `error.errors[].reason`, Brave samym kodem — dlatego werdykt
  (`SearchProviderOutcome.fatal`) wraca z adaptera, a nie jest zgadywany w fasadzie.
  `DISCOVER_MAX_SEARCHES` (domyślnie 300) pilnuje rachunku: ~10 zapytań na gminę, więc Poznań +15 km
  to ~130, a Warszawa z dzielnicami 200+ — darmowa pula Serpera (2500) starcza na kilkanaście przebiegów,
- **`dead` nie zależy od wyszukiwarki, ale naprawa ma pierwszeństwo.** Domena nierozwiązywalna w DNS
  jest oznaczana `dead` od razu, gdy nie ma czym szukać — wcześniej brak klucza kończył się
  `outcome: "error"` z nietkniętym źródłem i sześć nieistniejących domen `daily` odpytywało codziennie.
  Gdy wyszukiwarka JEST, naprawę próbujemy zawsze, także dla `dns-dead`: martwa domena nie znaczy
  martwej instytucji. `gokis-kleszczewo.pl` nie istnieje, ale GOKiS Kleszczewo działa pod
  `gokis.kleszczewo.pl` — i właśnie takie przypadki naprawa ma łapać,
- padnięty Overpass → discovery samego miasta centralnego zamiast utraty całego przebiegu, ale **4xx
  jest w raporcie oznaczone osobno**: to odbity nasz request, więc powtórzenie przebiegu go nie naprawi.
  Overpass wymaga własnego User-Agenta (`Mozilla/…` dostaje 406 tak samo jak brak nagłówka), a gminy
  zbieramy dwoma zapytaniami — bbox miasta, potem gminy w rozszerzonym prostokącie przycięte do
  promienia u nas. `(around.<relacja>:R)` wygląda naturalniej i zwraca **zero** elementów po dwóch
  minutach: `around` mierzy od węzłów zbioru, a relacja graniczna sama żadnych nie wnosi,
- **wycinanie chromu strony: tylko semantyka, nigdy klasy.** `page-fetch.ts` zdejmuje przed
  wysłaniem do modelu `nav`/`header`/`footer`/`aside`/`script`/`style`/`noscript` i role ARIA
  (`banner`, `navigation`, `contentinfo`, `search`). Wariant po klasach (`[class*=nav]`,
  `[class*=menu]`) wygląda dwa razy lepiej w liczbach — i kasuje ładunek: na poznan.pl treść
  kurczyła się o 50%, a linki do wydarzeń z 1 na 0, bo CMS trzyma listę wyników w kontenerze
  z „nav" w nazwie klasy. Zysk wersji bezpiecznej: ~1% na stronach-listach, ~13% na followupach
  (stronach pojedynczych wydarzeń), gdzie chrom jest większością dokumentu,
- **ucięta odpowiedź modelu to nie zepsuty JSON.** `finish_reason: length` jest raportowane jako
  `parse: "truncated"` (nie `bad-json`), a z niedomkniętej tablicy odzyskujemy kompletne rekordy
  sprzed miejsca przerwania — `JSON.parse` kasował je razem z jednym niedokończonym, po opłaconym
  już wywołaniu. Sufit odpowiedzi: `DISCOVER_MAX_TOKENS` / `EXTRACT_MAX_TOKENS` (domyślnie 12000).
  W ekstrakcji ta sama wada była CICHSZA i kosztowniejsza: `parseModelJson` łapało wyjątek
  i zwracało pustą listę, więc ucięta odpowiedź wyglądała identycznie jak strona bez wydarzeń
  (`status: "empty"`). Trzy poznańskie portale stały tak przez pięć przebiegów, płacąc ~$0.49
  dziennie za zero wydarzeń — i to jest cała odpowiedź na pytanie „czemu są jałowe",
- odpowiedź modelu jest **walidowana**, nie rzutowana: rekord bez URL-a odpada, nieznane `type`/`fetch`
  są normalizowane, a kolizja `id` dostaje sufiks — `id` jest kluczem cache ekstrakcji w `state.json`,
  więc duplikat cicho scalałby dwa różne źródła,
- adresy FB (`fb`, `fb_group`, `fb_event`) są pomijane w weryfikacji URL-i: login wall potrafił
  wypchnąć żywą grupę w `dead:true`, po czym daily przestawało ją odpytywać,
- `discover-runs.json` przechodzi przez redakcję PII (`src/pipeline/pii.ts`) tak samo jak `runs.json` — opisy
  wyników dla zapytań `site:facebook.com/groups` potrafią zawierać numery i e-maile mieszkańców.

## Cache ekstrakcji (state.json)

Hash treści oszczędza wywołania LLM, ale **sam hash nie wystarczy**: gdy „niezmienione" znaczyło
„zwróć zero wydarzeń", źródło znikało z `events.json` do czasu, aż jego strona się zmieni
(w przebiegu z 2026-07-23 do serwisu trafiło 8 źródeł z 46 — reszta wypadła). Dlatego
`state.extractions` trzyma **wynik ekstrakcji**, a nie tylko hash:

```
extractions: { "<source.id | URL followupa>": { hash, events, at, etag?, lastModified? } }
followupsBySource: { "<source.id>": ["<URL plakatu/PDF-a>", …] }
```

- **Strona bez zmian** → wydarzenia wracają z cache, `status: unchanged`, zero wywołań LLM.
- **Followupy sprawdzane zawsze**, także gdy strona się nie zmieniła — plakat czy `program.pdf`
  potrafi zostać podmieniony pod tym samym URL-em przy nietkniętym tekście strony. Bez
  `followupsBySource` nie wiedzielibyśmy, co sprawdzić (followupy pochodzą z ekstrakcji strony).
- **Warunkowy GET** (`If-None-Match` / `If-Modified-Since`) — gdy serwer odpowie `304`,
  plakat nie jest w ogóle pobierany. Gdy nie obsługuje walidatorów, decyduje hash treści.
- `outcome: unchanged` przy followupie = treść identyczna, wydarzenia odtworzone z cache.

⚠️ Pierwszy przebieg po tej zmianie **przeekstrahuje wszystkie źródła raz** (stary `state.json`
ma `hashes`, ale nie ma zapisanych wydarzeń) — jednorazowo ok. pełnej stawki z tabeli kosztów.

Cache jest w publicznym repo, więc trzymane w nim wydarzenia są **po** redakcji PII;
pełna wersja z dnia ekstrakcji żyje w prywatnym archiwum.

### Co widać z podziału na bloki

Podział jest miejscem, w którym powstaje rachunek: strona wchodzi jako HTML, wychodzi jako
bloki, a płacimy za te, których cache nie zna. Ślad pokazuje to na trzech poziomach — bo
pierwsze dwa są publiczne (`audit.json`), a trzeci niesie cudzą treść i zostaje w archiwum:

| gdzie | co mówi |
|---|---|
| krok `block` | `podział: DOM, 38 kart → 41 bl. / 28 431 zn.; 39 z cache, 2 do modelu (1 204 zn., 4% treści)` — znaki obok liczby bloków, bo „2 z 41 bloków" brzmi jak nic, a bywa połową strony |
| krok `block` (drugi wariant) | `bez kart mimo 3 grup rodzeństwa — tniemy po akapitach. div.tile ×5 (18 zn. — poniżej progu karty)`: **czemu** ta strona nie została rozpoznana jako lista. Wcześniej „nie ma listy" i „jest, ale nie po naszemu" wyglądały identycznie |
| krok `block.parsed` | co z tego wyszło: ile wydarzeń dały świeże bloki, ile cache, ile bloków opłaconych **bez ani jednego** wydarzenia (`silent` — menu, licznik, banner cookies) |
| `blocks/…` w archiwum | wiersz na blok: hash, rozmiar, karta czy reszta strony, z cache czy do modelu, od kiedy w cache'u, ile wydarzeń dał — plus **treść** tych, za które dziś zapłaciliśmy. Zapisywane tylko wtedy, gdy cokolwiek poszło do modelu |

Ostatni wiersz odpowiada na jedyne pytanie, którego z rachunku nie da się postawić: *ten blok
kosztuje codziennie — co się w nim właściwie rusza?* Reszta strony stoi już w `raw/`, a dzień
bez ani jednego świeżego bloku nie zapisuje obiektu w ogóle — archiwum rośnie tylko o dni,
w których naprawdę coś zapłaciliśmy.

## Dane osobowe (PII)

Repo jest **publiczne**, a strony instytucji podają numery kontaktowe osób prowadzących zapisy.
`src/pipeline/pii.ts` redaguje je tuż przed zapisem — `events.json`, `index.html`, `runs.json`
i job summary zawierają już wersję oczyszczoną.

| dane | decyzja | dlaczego |
|---|---|---|
| numer stacjonarny (kierunkowy, np. `61 …`) | **zostaje** | centrala instytucji publicznej, nie osoba; bez niego pole „zapisy" traci sens |
| komórka (prefiks `50/51/60/66/72/…`) | **usuwana** → `[tel. w źródle]` | zwykle prywatny numer pracownika |
| e-mail | **usuwany** → `[e-mail w źródle]` | j.w. |
| 9-cyfrowy numer o nieznanym prefiksie | **usuwany** | fail closed |
| URL-e (w tym `fb.me/e/…`) | nietknięte | nie są PII; wycinane z redakcji, żeby numeryczne id nie wyglądały jak telefon |

Użytkownik ma zawsze `source_url` — instytucja publikuje kontakt u siebie, w kontekście.
Ekstrakcja **nadal wyciąga** pełne dane (prompt bez zmian): redakcja jest warstwą na granicy
publikacji, więc pełna wersja pojedzie do prywatnego archiwum (Supabase Storage) bez zmian w promptach.

**Historia gita** została przepisana 2026-07-24 (`git filter-repo --replace-text`): numer zniknął
ze wszystkich 13 commitów, a nieusunięta po merge'u gałąź `observability-run-report` (też go zawierała)
została skasowana. Pozostaje jedno miejsce poza naszą kontrolą: **`refs/pull/1/head`** wciąż wskazuje
stary commit `28dbd29` i jest osiągalny przez bezpośredni URL do SHA — refów PR-ów nie da się usunąć
z zewnątrz, trzeba poprosić [GitHub Support](https://support.github.com/) o wyczyszczenie.

## Prywatne archiwum (Supabase Storage)

Publiczne repo trzyma dane **zredagowane** + metryki. To, czego nie wolno publikować, a bez czego
nie da się debugować jakości ekstrakcji, idzie do prywatnego bucketa:

| prefiks | zawartość | po co |
|---|---|---|
| `raw/<data>/<source>/<sha256>.json` | pobrany tekst strony/PDF-a 1:1 | „czemu to źródło dało 0 wydarzeń?" — widać, co model dostał (cookie banner? pusta strona?) |
| `raw/<data>/discover-<gmina>/…` | komplet wyników wyszukiwarki dla gminy | „czemu model przeoczył ten dom kultury?" — czy w ogóle był w wynikach |
| `llm/<data>/<runId>/<nnnn>-<model>.json` | prompt + odpowiedź + tokeny/koszt/czas | odróżnia „model nie widział" od „model zwrócił zły JSON"; zapisywane **także dla wywołań nieudanych** |
| `blocks/<data>/<runId>/<source>/<nnnn>.json` | rozliczenie podziału na bloki: wejście (znaki HTML-a i tekstu), rozpoznanie kart (w tym grupy ODRZUCONE — i czemu), wiersz na blok: hash, rozmiar, karta czy reszta strony, z cache czy do modelu, ile wydarzeń dał; **treść tylko tych bloków, za które dziś zapłaciliśmy**. Powstaje **tylko w dniach ze świeżymi blokami** — dzień w pełni z cache'a nie ma czego tłumaczyć | „czemu strona bez zmian znowu kosztowała?" — widać KTÓRY blok się rozjechał i o ile |
| `events/<data>/<runId>.json` | wydarzenia **przed** redakcją PII | pełne kontakty do digestu; źródło prawdy |

Ścieżka `raw/` zawiera sha256 treści → niezmieniona strona nie zajmuje miejsca drugi raz.
Obrazy (plakaty base64) **nie** trafiają do `llm/` — zostaje sam rozmiar, żeby nie zapychać bucketa.

**Setup (5 min):**
1. [supabase.com](https://supabase.com) → nowy projekt (darmowy tier ~1 GB storage).
2. Storage → New bucket → nazwa `archive`, **Private** (nie zaznaczaj „Public bucket").
3. Settings → API Keys → skopiuj `Project URL` i **Secret key** (`sb_secret_…`).
   Supabase przemianował klucze: **Secret** = dawny `service_role`, **Publishable** = dawny `anon`.
   Publishable/anon **nie** odczyta prywatnego bucketa — kod ostrzega i odmawia startu, jeśli go podasz.
   Starsze projekty pokazują jeszcze klucze JWT (`eyJ…`); obie nazwy zmiennej działają.
4. GitHub → Settings → Secrets and variables → Actions → dodaj `SUPABASE_URL`
   i `SUPABASE_SECRET_KEY` (albo `SUPABASE_SERVICE_ROLE_KEY` przy starym kluczu).

Lokalnie wystarczy uzupełnić `.env` (patrz `.env.example`) — żadnych zmiennych w powłoce:

```ini
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...     # Secret key, NIE Publishable
# opcjonalnie: SUPABASE_BUCKET=archive, ARCHIVE_RETENTION_DAYS=90
```

⚠️ Klucz sekretny (Secret / service_role) omija RLS — wyłącznie backend/Actions/lokalny most, **nigdy** frontend ani panel.
Bez tych zmiennych `archive.ts` jest cichym no-opem: `npm run daily` działa lokalnie bez konfiguracji,
a błąd archiwum nigdy nie wywraca pipeline'u (to observability, nie produkt).

Supabase nie ma lifecycle rules — retencję (`ARCHIVE_RETENTION_DAYS`, domyślnie 90 dni)
trzeba egzekwować cyklicznym czyszczeniem starych prefiksów; **jeszcze niezaimplementowane**.

### Lokalny most panelu: dane z drzewa roboczego + podgląd archiwum + sonda źródeł

Panel na GH Pages to statyczny bundle — wszystko, co potrafi zrobić sam, potrafi też każdy
odwiedzający. Trzy rzeczy muszą więc zostać na twojej maszynie: **klucz do archiwum**,
**uruchamianie potoku** (pobranie strony + płatne wywołanie modelu) oraz **pliki, których
jeszcze nie ma na GitHubie**. Robi je jeden proces:

```bash
# terminal 1 — most (klucz z .env, nasłuch tylko na 127.0.0.1)
npm run panel-server

# terminal 2 — panel z localhosta
cd panel && npm start
```

Panel sam wykrywa most (`/health`) i odsłania przyciski; bez mostu chowa je i pokazuje
`runs.json` jak dotąd. Archiwum jest przy tym **opcjonalne** — bez `SUPABASE_*` most i tak
wstaje, bo sonda niczego od Supabase nie potrzebuje.

**Dane: `main` czy drzewo robocze.** Domyślnie panel czyta
`raw.githubusercontent.com/…/main`, czyli stan OPUBLIKOWANY — bo wdrożony panel innego źródła
nie ma. Skutek uboczny był jednak dotkliwy: przebieg puszczony lokalnie zapisuje do drzewa
roboczego i **był niewidoczny aż do commita i pusha** (plus kilka minut cache CDN), czyli
iteracja nad discovery wyglądała jak „zatwierdź, żeby zobaczyć, co zatwierdzasz".

Gdy most stoi, pliki idą z niego (`GET /file?name=…`) i widać także niezacommitowane przebiegi.
W nagłówku panelu jest znacznik **`local`** (wyróżniony) albo **`main`** — bez niego nie da się
odróżnić jednego stanu od drugiego z samego ekranu, a to była pierwotna pomyłka.

Most oddaje **jawną listę** plików (`sources.json`, `events.json`, `runs.json`, `audit.json`,
`discover-runs.json`, `costs.json`) mapowaną nazwa → ścieżka. Nie sklejamy katalogu z parametrem,
więc `?name=../.env` nie jest walidowane — ono po prostu nie istnieje w mapie.
Dopóki most nie odpowie na `/health`, panel **nie wysyła żadnego żądania o dane**: inaczej każdy
plik leciałby dwa razy, a użytkownik zdążyłby zobaczyć stan z `main` i mu uwierzyć.

**Podgląd archiwum.** `runs.json` niesie **ścieżki** obiektów (`SourceRun.archive`) — same
ścieżki nie są wrażliwe, więc wdrożony panel pokazuje listę i informację, że treść jest prywatna.
Krok `llm` w śladzie niesie ścieżkę SWOJEGO wywołania (`detail.archive`), więc prompt otwiera się
przyciskiem przy tym kroku, a nie przez zgadywanie, który numer z listy to ten, o który chodzi.
Tak samo Bright Data: surowa migawka grupy ląduje pod `raw/<dzień>/<id>__bd/` (osobno od
spłaszczonego tekstu, który idzie do modelu), a paczka wydarzeń FB pod `raw/<dzień>/fb-events/` —
obie podpięte do swojego kroku śladu. To jedyne miejsce, gdzie widać, co scraper faktycznie oddał
za opłacone rekordy: wiersze błędu, pola obrazów i miejsc, których spłaszczanie nie bierze.

Redakcja PII **omija** `detail.archive`. Ścieżki `raw/` niosą sha256, a w haszu regularnie trafia
się dziewięciocyfrowy ciąg z prefiksem komórkowym — redakcja zrobiłaby z niego `[tel]`, czyli
martwy przycisk, i to tylko dla części źródeł (patrz `NEVER_REDACTED` w `reporting/audit-trail.ts`).
Most akceptuje tylko prefiksy `raw/`, `llm/`, `blocks/`, `events/`, `reuse/` (bez `..`), więc nie da
się przez niego czytać dowolnych obiektów z projektu.

**Bezpieczeństwo.** CORS przepuszcza **wyłącznie** `localhost`/`127.0.0.1`, a sonda dodatkowo
sprawdza nagłówek `Origin` i przyjmuje tylko `POST`. To nie jest ta sama ochrona co CORS: CORS
blokuje *odczyt odpowiedzi*, nie samo żądanie — bez sprawdzenia `Origin` dowolna otwarta karta
mogłaby po cichu odpalać płatne wywołania modelu na twoim localhoście.

## Sonda: sprawdź jedno źródło na żądanie

Żeby zobaczyć, co potok robi z jednym adresem, nie trzeba czekać do 6:00 ani puszczać 46 źródeł.
Ten sam `processSource`, jedno źródło, natychmiast — z panelu (**Check now** / **Force** na stronie
źródła) albo z terminala:

```bash
npm run probe -- kornik-kok            # cache w mocy: niezmieniona strona wraca z cache, $0
npm run probe -- kornik-kok --force    # pomiń cache: pobierz od nowa i zawołaj model (PŁATNE)
```

**Sonda niczego nie zapisuje** — ani `events.json`, ani `state.json`, ani `runs.json`/`costs.json`/
`audit.json`. Klik w panelu nie ma prawa ruszyć plików w repo: brudziłby drzewo robocze i wchodził
do najbliższego commita, a zapisany cache ekstrakcji zafałszowałby najbliższy przebieg crona
(„niezmienione" mimo że nikt tej treści nie opublikował). Wynik żyje w odpowiedzi HTTP i znika
po odświeżeniu strony.

Co daje, czego nie ma widok przebiegu:

| | |
|---|---|
| **prompty i odpowiedzi modelu wprost** | bez chodzenia do archiwum — sonda nie wysyła ich do Supabase, tylko odsyła do panelu (`suppressArchive`) |
| **wydarzenia przed dedupe i przed redakcją PII** | widać, co źródło naprawdę dało, a nie co przetrwało resztę potoku; dane zostają na localhoście |
| **ślad decyzyjny na żywo** | ten sam timeline co `audit.json`, tyle że z tej chwili |

`--force` czyści dla tego źródła walidatory HTTP, hash i zapamiętane wydarzenia — razem z
followupami, bo plakat z cache dałby ten sam wynik co wczoraj. Cache **geokodera** zostaje
nietknięty: Nominatim jest darmowy, ale limitowany do 1 zapytania na sekundę, a sonda sprawdza
ekstrakcję, nie geokodowanie.

Sonda nie obsługuje fanpage'y FB (`fetch:fb`) ani pojedynczych linków do wydarzeń (`fetch:fb_event`)
— jedno i drugie rozwiązuje zbiorcze zapytanie do Bright Data na końcu **pełnego** przebiegu.
Źródła oznaczone `dead` sprawdza normalnie: „czy ten adres wrócił do życia" to dokładnie ten
przypadek, dla którego sonda powstała.

Most puszcza **jedną sondę naraz** (druga dostaje HTTP 409). Ślad, licznik tokenów i recorder
wywołań LLM to stan modułowy — dwie równoległe pomieszałyby sobie kroki i koszty; przy okazji
przytrzymany przycisk nie zamieni się w dziesięć równoległych wywołań modelu.

## Jakość: progi rozmiaru i bramka CI

Kod potrafi urosnąć niepostrzeżenie — `discover.ts` miał w szczycie 1146 linii. Progi
pilnuje ESLint (`eslint.shared.js`, wspólne z panelem), a `ci.yml` odpala je na każdym
PR-ze i pushu do `main`:

```bash
npm run typecheck   # tsc na src/ i test/
npm run lint        # progi rozmiaru + reguły typowane
npm test            # node:test przez tsx, bez dodatkowych zależności
```

**Twarde (wywracają CI):** 350 linii kodu na plik · 120 znaków na linię · zagnieżdżenie ≤ 4 ·
≤ 4 parametry · ≤ 3 zagnieżdżone callbacki. Liczone bez pustych linii i komentarzy — gęsty
JSDoc w tym repo jest dokumentacją decyzji, nie długiem.

**Ostrzeżenia:** długość i złożoność funkcji. Zostało pięć orkiestratorów wejścia/wyjścia
(`run`, `collect`, `chat`, `discoverTown`, `processSource`/`processFollowup`), których nie da się
sprawdzić bez płatnego przebiegu — lista i uzasadnienie są w `eslint.shared.js`. Wszystko, co dało
się rozciąć pod osłoną testu albo wyjścia bajt-w-bajt, jest już rozcięte: przy rozbiciu etapu 1
na profiler zeszły z listy `main` (rozdzielacz trybów + `runDiscovery`/`runStages`/`persist`),
`verifySource` (`onReachable`/`onUnreachable` + `verify/profile.ts`) oraz `webSearch`
(budżet przeniesiony do `adapters/search.ts`).

Wyrocznie offline (darmowe, bez sieci), przydatne przy każdej zmianie w potoku:

```bash
npx tsx src/actions/discover.ts --why "poznan-kultura"   # czyta tylko zapisany stan
npx tsx src/actions/digest.ts                            # dry-run bez .env
npm run backfill-costs -- --force                        # przelicza księgę z raportów
```

⚠️ `npm run digest` ładuje `.env` i przy ustawionym `TELEGRAM_BOT_TOKEN` **naprawdę wyśle** —
do podglądu używaj `npx tsx` bez `--env-file`.

## Parametry konfiguracji

Rejestr siedzi w `src/config/params.ts` i jest **jedynym** miejscem, w którym potok czyta
konfigurację — pilnuje tego test, więc lista poniżej nie może być niepełna. Dopisując parametr:
wpis w rejestrze, potem `npm run config:docs`, który przebudowuje tę tabelę, `.env.example`
i klucze w `config.json`.

`config.json` jest commitowany i trzyma **progi** potoku. Generator pilnuje w nim wyłącznie
kluczy — **wartości są Twoje i żadna przebudowa ich nie nadpisze**. Powód rozdziału jest jeden:
próg zmieniony w sekretach repozytorium nie zostawia śladu nigdzie, więc pytania „od kiedy
wyciszamy tak agresywnie" nie da się nawet postawić. Ten sam próg w pliku daje
`git log -p config.json`, a raport przebiegu niesie migawkę progów, którymi się kierował —
łącznie z listą tych, które tamtej nocy przyszły ze środowiska (`config.fromEnv`), bo tylko
tego nie widać w historii.

<!-- BEGIN GENERATED: config -->

<!-- Tabela poniżej jest generowana z src/config/params.ts przez `npm run config:docs`.
     Ręczne zmiany przepadną — popraw wpis w rejestrze. -->

Wszystkie 56 parametrów, jakie potok czyta z konfiguracji. Kolumna **klasa** mówi,
czym parametr jest i — co ważniejsze — GDZIE mieszka:

- **próg** (24 sztuk) — steruje zachowaniem potoku i stoi w commitowanym `config.json`.
  Zmiana progu ma zostawiać ślad: `git log -p config.json` daje datę, autora i wartość przed i po,
  do zestawienia z tym, co w tych dniach robił potok. Każdy przebieg zapisuje w raporcie migawkę
  progów, którymi się kierował (`RunReport.config`), więc stary raport da się czytać bez zgadywania.
- **sekret** — klucz albo token, wyłącznie ze środowiska. Do repo nie trafia nigdy i `config.json`
  go nie odczyta, nawet gdyby ktoś wpisał tam jego nazwę.
- **ustawienie** — wybór właściciela (model, dostawca, adresat digestu), ze środowiska.
- **adres** — punkt końcowy API; przydaje się przy proxy i mockach, normalnie zostaw domyślny.
- **środowisko** — daje runner (GitHub Actions), nie ustawia się tego ręcznie.

Pierwszeństwo: `process.env` → `config.json` → wartość domyślna. Env jest na górze, żeby doraźny
eksperyment nie wymagał commita — kolumna **Domyślnie** pokazuje wartość z rejestru, czyli tę,
która obowiązuje, gdy nie ustawiono nic. Dłuższe uzasadnienia stoją przy wpisach w `.env.example`.

**wymagane: ekstrakcja i discovery**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | brak | sekret | klucz do OpenRoutera — bez niego nie ruszy ani ekstrakcja, ani discovery |

**discovery / naprawa martwych URL-i**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `SERPER_API_KEY` | brak | sekret | klucz Serpera — bez niego discovery i naprawa martwych URL-i nie działają |
| `SEARCH_PROVIDER` | `serper` | ustawienie | serper (domyślnie) \| google \| brave |
| `GOOGLE_API_KEY` | brak | sekret | tylko dla SEARCH_PROVIDER=google (konta sprzed 07.2026) |
| `GOOGLE_CSE_CX` | brak | ustawienie | id silnika; MUSI mieć włączone „Search the entire web” |
| `BRAVE_API_KEY` | brak | sekret | tylko dla SEARCH_PROVIDER=brave (2000 zapytań/mies. gratis) |
| `DISCOVER_MAX_SEARCHES` | `300` | próg | sufit zapytań do wyszukiwarki na jeden przebieg discovery |

**opcjonalnie: ewaluacja innych modeli bez zmian w kodzie**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `MODEL_EXTRACT` | `anthropic/claude-haiku-4.5` | ustawienie | model codziennej ekstrakcji — musi umieć obrazy i JSON po polsku |
| `MODEL_DISCOVER` | `anthropic/claude-sonnet-4.6` | ustawienie | model miesięcznego discovery — mocniejszy, bo ocenia trafienia wyszukiwarki |

**opcjonalnie: structured outputs (response_format: json_schema)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `STRUCTURED_OUTPUTS` | `true` | ustawienie | `0` wyłącza wymuszony JSON Schema na odpowiedzi modelu |
| `STRUCTURED_IGNORE_PROVIDERS` | `azure` | ustawienie | dostawcy OpenRoutera pomijani na ścieżce ze schematem (po przecinku) |

**opcjonalnie: Facebook przez Bright Data (linki do wydarzeń + otwarte grupy)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `BRIGHTDATA_API_KEY` | brak | sekret | klucz Bright Data — bez niego cały kanał FB jest pomijany |
| `BD_MAX_FB_EVENTS` | `40` | próg | sufit rozwijanych linków do wydarzeń FB na jeden przebieg |
| `BD_DATASET_FB_EVENTS` | `gd_m14sd0to1jz48ppm51` | ustawienie | id scrapera wydarzeń FB (nadpisanie na wypadek zmian po stronie BD) |
| `BD_DATASET_FB_GROUP_POSTS` | `gd_lz11l67o2cb3r0lkj3` | ustawienie | id scrapera postów z grup FB |
| `BD_POLL_MS` | `10000` | próg | co ile odpytywać Bright Data o gotowość migawki |
| `BD_TIMEOUT_MS` | `480000` | próg | po tylu ms migawka jest porzucana i anulowana (awaria 2026-08-10) |
| `FB_GROUP_BLOCKED_LIMIT` | `3` | próg | po tylu płatnych wierszach błędu z rzędu grupa jest pomijana |
| `FB_GROUP_BLOCKED_RECHECK_DAYS` | `14` | próg | co tyle dni jedna sonda do pomijanej grupy — jedyna droga powrotna |
| `FB_GROUP_LIMIT_MAX` | `50` | próg | sufit rekordów na grupę; regulator może zejść niżej, nigdy wyżej |
| `FB_GROUP_LIMIT_MIN` | `5` | próg | podłoga rekordów na grupę |
| `FB_GROUP_LIMIT_MARGIN` | `0.2` | próg | zapas ponad pokrycie przerwy między pobraniami (0.2 = 20%) |
| `FB_MAX_USD_PER_EVENT` | brak | próg | próg $ za wydarzenie spoza sieci; brak = mechanizm w ogóle nie działa |
| `FB_YIELD_MIN_RUNS` | `5` | próg | minimum realnych pobrań, zanim próg zapadnie |
| `FB_MUTE_DAYS` | `30` | próg | na ile dni wycisza, zanim źródło wróci do pomiaru |
| `FB_MIN_SOURCES_PER_TOWN` | `1` | próg | ile grup FB zostaje w gminie mimo progu; 0 wyłącza podłogę |

**potok: sufity i tryby (tokeny, wywołania LLM, punkt wejścia)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `EXTRACT_MAX_TOKENS` | `12000` | próg | sufit tokenów odpowiedzi przy ekstrakcji wydarzeń |
| `DISCOVER_MAX_TOKENS` | `12000` | próg | sufit tokenów odpowiedzi przy ocenie trafień wyszukiwarki |
| `BLOCK_MAX_CALLS` | `80` | próg | sufit wywołań LLM na blokowanie źródeł w przebiegu (0 = nie wołaj) |
| `ENTRYPOINT_LLM` | `always` | próg | kiedy pytać model o punkt wejścia gminy: always \| ambiguous \| never |
| `CONFIG_FILE` | `true` | ustawienie | `0` ignoruje config.json — przebieg na samych wartościach domyślnych |

**prywatne archiwum treści (Supabase Storage)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `SUPABASE_URL` | brak | ustawienie | adres projektu Supabase; brak = archiwum wyłączone, reszta działa |
| `SUPABASE_SECRET_KEY` | brak | sekret | klucz Secret (sb_secret_…), NIE Publishable — omija RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | brak | sekret | dawna nazwa tego samego klucza (projekty z JWT eyJ…) |
| `SUPABASE_BUCKET` | `archive` | ustawienie | bucket archiwum treści |
| `ARCHIVE_RETENTION_DAYS` | `90` | próg | po tylu dniach obiekty archiwum idą do skasowania |
| `ARCHIVE_PORT` | `8787` | ustawienie | port lokalnego mostu panelu (npm run panel-server) |

**księga kosztów (costs.json)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `COST_MONTHLY_BUDGET_USD` | `15` | próg | linia odniesienia w panelu (nie limit twardy) |
| `COST_RETENTION_DAYS` | `90` | próg | ile dni kwot trzyma księga (runs.json trzyma 7 dni szczegółów) |
| `BD_COST_PER_RECORD` | `0.0015` | próg | stawka Bright Data za rekord (potwierdź w panelu BD) |
| `SEARCH_COST_PER_QUERY` | `0.001` | próg | stawka za zapytanie: Serper ~0.001, Google 0.005, Brave 0 |
| `SUPABASE_COST_PER_GB_MONTH` | `0` | próg | stawka za GB archiwum na miesiąc (darmowy tier ~1 GB) |
| `SCRAPE_COST_PER_FETCH` | `0` | próg | stawka za pobranie strony (GH Actions dla repo publicznego: 0) |

**digest (Telegram aktywny, e-mail w zapasie)**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | brak | sekret | token bota; brak = digest Telegramem wyłączony |
| `TELEGRAM_CHAT_ID` | brak | ustawienie | dokąd bot wysyła digest |
| `DIGEST_CHILD_AGE` | brak | ustawienie | wiek dziecka; brak = digest bez filtra wiekowego |
| `RESEND_API_KEY` | brak | sekret | klucz Resend — e-mailowy wariant digestu, w zapasie |
| `DIGEST_TO` | brak | ustawienie | adresat e-maila; brak = wariant e-mail wyłączony |
| `DIGEST_FROM` | `events-pl <onboarding@resend.dev>` | ustawienie | nadawca e-maila |

**adresy API — do proxy i mocków w testach, normalnie zostaw puste**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1/chat/completions` | adres | adres chat completions |
| `SERPER_URL` | `https://google.serper.dev/search` | adres | adres wyszukiwarki Serper |
| `BRAVE_URL` | `https://api.search.brave.com/res/v1/web/search` | adres | adres wyszukiwarki Brave |
| `GOOGLE_URL` | `https://www.googleapis.com/customsearch/v1` | adres | adres Google Programmable Search |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | adres | adres Overpass (OSM) — do własnej instancji, gdy publiczna dławi |

**od środowiska, nie od nas**

| Parametr | Domyślnie | Klasa | Do czego |
| --- | --- | --- | --- |
| `GITHUB_ACTIONS` | brak | środowisko | ustawia runner — po tym poznajemy, że jesteśmy w Actions |
| `GITHUB_STEP_SUMMARY` | brak | środowisko | ścieżka pliku job summary; poza Actions nie istnieje |

<!-- END GENERATED: config -->

## Znane ograniczenia / TODO

- FB: linki do wydarzeń + otwarte grupy przez Bright Data (sekcja wyżej). Fanpage (`fetch:"fb"`)
  wciąż pomijane w daily — inny dataset; grupy zamknięte świadomie poza zakresem (ban risk).
- Dedupe: trzy przejścia — klucz `tytuł+data`, tożsamość udostępnionego oryginału FB
  (`origin.key`, jedyne działające PONAD miejscowością) i zawieranie tytułu w kubełkach po
  miejscowości. LLM-owy dedupe (`DEDUPE_SYSTEM`) gotowy w prompts.ts, niepodpięty.
  Zwycięzcę wybiera długość JSON-a („bogatszy rekord"), więc `source_id` tego samego wydarzenia
  potrafi się zmieniać z dnia na dzień — teraz widać to w panelu jako `merged → <źródło>`.
- Weryfikacja URL-i: `discover --verify` (miesięczny cron `discover.yml`) sprawdza każdy URL, naprawia
  przez search+LLM (historia w `previous_urls`), nienaprawialne znakuje `dead:true` (daily pomija jako
  `skipped-dead` do następnej udanej naprawy). Adresy FB są pomijane (login wall ≠ martwy URL),
  więc grupy z Bright Data weryfikuje dopiero daily.
- Proweniencja: 46 źródeł z ręcznego etapu 1 nie ma `provenance` (patrz sekcja observability etapu 1).
  Backfill jest możliwy tylko przez ponowne discovery — świadomie niezrobiony, bo kosztowałby
  pełny przebieg Sonneta dla danych, które i tak nie odtworzą wyników wyszukiwarki sprzed miesięcy.
- Tagi zagnieżdżone (`dzieci:dmuchańce`, `warsztaty:ceramika`) generuje prompt — słownik warto ustabilizować po ~2 tyg. danych.
- Powiadomienia: dodać `src/actions/digest.ts` (czwartek 17:00, filtr wiek+weekend → mail/Telegram) — trywialne rozszerzenie.
- Walidacja odpowiedzi LLM: typy są rzutowane (`as ExtractionResult`); produkcyjnie warto dodać `zod` schema → `EventItem`.
