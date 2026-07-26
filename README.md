# events-pl — agregator wydarzeń lokalnych (pipeline 2-etapowy, Node/TS, OpenRouter)

## Architektura

```
STAGE 1 (miesięcznie / nowe miasto)         STAGE 2 (codziennie)
─────────────────────────────────           ────────────────────────────────
miasto + promień                            sources.json
  → Overpass API (gminy w promieniu)          → fetch (ETag/304 + hash treści)
  → wyszukiwarka (Brave, darmowy tier)        → bez zmian? wydarzenia z cache, 0 LLM
  → SONNET: triage kandydatów                 → HAIKU: ekstrakcja → JSON
  → sources.json (+ provenance przy źródle)   → followups (1 hop): PDF-y programów,
  → weryfikacja URL-i (też --verify solo):      podstrony, plakaty JPG (vision)
    martwy URL → Brave + HAIKU → naprawa     → geocode (Nominatim, darmowe, cache)
    (stary adres → previous_urls) albo        → dedupe (heurystyka + LLM)
    dead:true (daily pomija)                  → events.json → index.html
  → discover-runs.json (observability)   src/actions/daily.ts → runs.json (observability)
src/actions/discover.ts  ·  --why <id> = skąd to źródło
```

## Pliki

| plik | rola |
|---|---|
| `sources.json` | rejestr źródeł Poznań +15 km (etap 1 wykonany ręcznie 2026-07-20; 46 źródeł, 13 gmin) + `provenance` przy każdym źródle dodanym automatycznie |
| `src/actions/` | wejścia potoku — `daily`, `discover`, `digest`, `backfill-costs`, `archive-server`. Same main() + orkiestracja, zero logiki dziedzinowej |
| `src/adapters/` | wyjścia do świata: `openrouter`, `brave`, `overpass`, `nominatim`, `page-fetch`, `brightdata`, `supabase-archive`, `telegram`, `resend`, `http` |
| `src/pipeline/` | logika dziedzinowa: `discover/` (discovery gmin, walidacja propozycji, `--why`), `verify/` (sonda + naprawa URL-i), `extract/` (ekstrakcja, followupy, wydarzenia FB), `digest/`, `dedupe`, `pii`, `facebook`, `prompts` |
| `src/reporting/` | agregaty, koszty, podsumowania Actions, redakcja PII, polityki retencji raportów |
| `src/storage/` | **port składowania** — `DocStore`/`CollectionStore` + implementacja na plikach JSON. Jedyne miejsce znające ścieżki; przejście na bazę to druga implementacja i podmiana wiązań w `storage/index.ts` |
| `src/shared/` | ścieżki, hash, tekst, daty, URL-e, formatowanie błędów |
| `src/types/` | typy podzielone po dziedzinach + jedyny barrel w repo (`types/index.ts`) |
| `test/` | testy `node:test` (93 przypadki): pii, url/slug/daty, dedupe, facebook, digest, koszty, retencja, podsumowania, walidacja propozycji |
| `discover-runs.json` | observability etapu 1: każde zapytanie search + wyniki, **każda propozycja modelu wraz z decyzją** (także odrzucenia), geo (Overpass), tokeny/koszt LLM per gmina / źródło / typ zadania (discovery vs weryfikacja); ostatnie 24 przebiegi (szczegóły dla 4 najnowszych) |
| `runs.json` | observability etapu 2: przebieg źródło po źródle (status, HTTP, followupy, tokeny/koszt per zadanie, rekordy Bright Data, ścieżki archiwum); **ostatnie 7 dni** (min. 2, maks. 30 przebiegów) |
| `costs.json` | księga wydatków obu etapów: linia na (przebieg × kategoria) z wolumenem, stawką i najdroższymi pozycjami; 90 dni. Zasila zakładkę **Money** |
| `eslint.shared.js` | wspólne progi rozmiaru dla potoku i panelu (max 350 linii kodu na plik, 120 znaków na linię) — pilnowane przez `ci.yml` |
| `template.html` | frontend (wiek dziecka, tagi zagnieżdżone, weekend, mapa OSM); `reporting/render-index.ts` wstrzykuje JSON |
| `panel/` | panel observability (Angular 22 + Taiga UI): **Day** (przegląd dnia → source runs → eventy + iframe podglądu), **Discovery** (proweniencja rejestru → przebiegi discover) i **Money** (wydatki dzień po dniu wg kategorii); deploy na GH Pages pod `/panel/` przez `deploy-pages.yml` (Settings → Pages → Source: GitHub Actions) |

## Setup

```bash
npm install                     # Node >= 22; playwright jest opcjonalny
# strony JS-only (CK Zamek itp.):
npm install playwright && npx playwright install chromium

cp .env.example .env            # (PowerShell: copy .env.example .env) → uzupełnij klucze
npm run daily                   # → events.json + index.html

# raz w miesiącu / nowe miasto (wymaga BRAVE_API_KEY w .env):
npm run discover -- "Poznań" 15 # pełne discovery + weryfikacja URL-i
npm run discover -- --verify    # sama weryfikacja/naprawa URL-i (tanio: Haiku; cron w discover.yml)
npm run discover -- --why lubon-ok   # skąd to źródło się wzięło (nie kosztuje nic, nie rusza sieci)

npm run typecheck               # tsc --noEmit (strict)
```

**Konfiguracja idzie przez `.env`** (wzór w `.env.example`, plik jest w `.gitignore`).
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
| `search` | Brave: zapytania | **szacunek** (darmowy tier 2000/mies. → stawka 0) |
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
   w raporcie przebiegu. Surowe posty lądują wyłącznie w prywatnym archiwum (`archiveRaw`), nie w repo —
   to treści z danymi osobowymi. Linki do wydarzeń z postów zasilają pulę z pkt 1.

**Discovery (etap 1)** dokłada zapytania `site:facebook.com/groups {town}` i `{town} grupa facebook
wydarzenia lokalne`; model triage'u zwraca otwarte grupy jako `fb_group`. Zamknięte grupy /
kupię-sprzedam są odrzucane.

**Przełączniki env** (wszystkie opcjonalne): `BD_DATASET_FB_EVENTS`, `BD_DATASET_FB_GROUP_POSTS`
(nadpisanie ID datasetu), `BD_POLL_MS` (10000), `BD_TIMEOUT_MS` (480000), `BD_MAX_FB_EVENTS` (40).

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

⚠️ 46 źródeł z ręcznego etapu 1 (2026-07-20) proweniencji nie ma i mieć nie będzie — panel i `--why`
mówią to wprost zamiast udawać. Zapisywana jest od pierwszego automatycznego `discover`.

**Twardość przebiegu** (etap 1 kosztuje realne pieniądze, więc awaria nie może kasować wyniku):

- raport i zmiany w `sources.json` zapisują się **także po wyjątku** (`partial: true` + `err` w raporcie);
  wyjątek przy naprawie jednego źródła nie przerywa weryfikacji pozostałych,
- Brave: 429/401 wyłącza wyszukiwarkę na resztę przebiegu (wcześniej limit wyglądał jak „brak wyników"),
  a `DISCOVER_MAX_SEARCHES` (domyślnie 300) pilnuje darmowego tieru 2000/mies.,
- padnięty Overpass → discovery samego miasta centralnego zamiast utraty całego przebiegu,
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

### Podgląd archiwum w panelu (tylko lokalnie)

`runs.json` niesie **ścieżki** obiektów (`SourceRun.archive`) — same ścieżki nie są wrażliwe,
więc wdrożony panel pokazuje listę i informację, że treść jest prywatna. Do treści potrzebny
jest lokalny most, bo klucz sekretny nie może trafić do statycznego bundla:

```bash
# terminal 1 — most (klucz czytany z .env, nasłuch tylko na 127.0.0.1)
npm run archive-server

# terminal 2 — panel z localhosta
cd panel && npm start
```

Panel sam wykrywa most (`/health`) i odsłania przyciski do podglądu obiektów; bez mostu sekcja
zostaje wyszarzona. CORS przepuszcza **wyłącznie** `localhost`/`127.0.0.1` — wdrożony panel na
GH Pages nie dogada się z mostem nawet przy uruchomionym serwerze, więc żadna publiczna strona
nie przeskanuje twojego localhosta. Most akceptuje tylko prefiksy `raw/`, `llm/`, `events/`
(bez `..`), więc nie da się przez niego czytać dowolnych obiektów z projektu.

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

**Ostrzeżenia:** długość i złożoność funkcji. Zostało osiem orkiestratorów wejścia/wyjścia
(`run`, `main`, `webSearch`, `collect`, `chat`, `discoverTown`, `processSource`/`processFollowup`,
`verifySource`), których nie da się sprawdzić bez płatnego przebiegu — lista i uzasadnienie
są w `eslint.shared.js`. Wszystko, co dało się rozciąć pod osłoną testu albo wyjścia
bajt-w-bajt, jest już rozcięte.

Wyrocznie offline (darmowe, bez sieci), przydatne przy każdej zmianie w potoku:

```bash
npx tsx src/actions/discover.ts --why "poznan-kultura"   # czyta tylko zapisany stan
npx tsx src/actions/digest.ts                            # dry-run bez .env
npm run backfill-costs -- --force                        # przelicza księgę z raportów
```

⚠️ `npm run digest` ładuje `.env` i przy ustawionym `TELEGRAM_BOT_TOKEN` **naprawdę wyśle** —
do podglądu używaj `npx tsx` bez `--env-file`.

## Znane ograniczenia / TODO

- FB: linki do wydarzeń + otwarte grupy przez Bright Data (sekcja wyżej). Fanpage (`fetch:"fb"`)
  wciąż pomijane w daily — inny dataset; grupy zamknięte świadomie poza zakresem (ban risk).
- Dedupe: heurystyka tytuł+data; LLM-owy dedupe (`DEDUPE_SYSTEM`) gotowy w prompts.ts, niepodpięty.
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
