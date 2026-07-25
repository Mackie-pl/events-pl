# events-pl — agregator wydarzeń lokalnych (pipeline 2-etapowy, Node/TS, OpenRouter)

## Architektura

```
STAGE 1 (miesięcznie / nowe miasto)         STAGE 2 (codziennie)
─────────────────────────────────           ────────────────────────────────
miasto + promień                            sources.json
  → Overpass API (gminy w promieniu)          → fetch (ETag/304 + hash treści)
  → wyszukiwarka (Brave, darmowy tier)        → bez zmian? wydarzenia z cache, 0 LLM
  → SONNET: triage kandydatów                 → HAIKU: ekstrakcja → JSON
  → sources.json                              → followups (1 hop): PDF-y programów,
  → weryfikacja URL-i (też --verify solo):      podstrony, plakaty JPG (vision)
    martwy URL → Brave + HAIKU → naprawa     → geocode (Nominatim, darmowe, cache)
    (stary adres → previous_urls) albo        → dedupe (heurystyka + LLM)
    dead:true (daily pomija)                  → events.json → index.html
  → discover-runs.json (observability)      src/daily.ts → runs.json (observability)
src/discover.ts
```

## Pliki

| plik | rola |
|---|---|
| `sources.json` | rejestr źródeł Poznań +15 km (etap 1 wykonany ręcznie 2026-07-20; 46 źródeł, 13 gmin) |
| `src/types.ts` | pełne typy: Source, EventItem (age/price/sub_slots/tags/conditional), State |
| `src/discover.ts` | etap 1 (Sonnet + Brave Search + Overpass) + weryfikacja/naprawa URL-i (`--verify`, cron miesięczny w `discover.yml`) |
| `discover-runs.json` | observability etapu 1: każde zapytanie search + wyniki, geo (Overpass), tokeny/koszt LLM per miasto / źródło / typ zadania (discovery vs weryfikacja); ostatnie 24 przebiegi |
| `src/daily.ts` | etap 2 (Haiku: ekstrakcja, kontenery, PDF przez `unpdf`, plakaty vision, geo, dedupe) |
| `src/prompts.ts` | prompty PL dla obu etapów |
| `src/pii.ts` | redakcja danych osobowych przed zapisem do publicznego repo (patrz niżej) |
| `src/archive.ts` | prywatne archiwum treści (Supabase Storage): surowe strony, wejścia/wyjścia LLM, dane przed redakcją |
| `src/archive-server.ts` | lokalny most do archiwum (`npm run archive-server`) — trzyma klucz sekretny poza panelem |
| `template.html` | frontend (wiek dziecka, tagi zagnieżdżone, weekend, mapa OSM); `daily.ts` wstrzykuje JSON |
| `panel/` | panel observability (Angular 22 + Taiga UI): przegląd dnia → source runs → eventy + iframe podglądu; deploy na GH Pages pod `/panel/` przez `deploy-pages.yml` (Settings → Pages → Source: GitHub Actions) |

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

Wymagania dla MODEL_EXTRACT: obsługa obrazów (plakaty) + solidny JSON po polsku. Struktura `src/llm.ts`
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

## Koszty (ceny 07.2026: Haiku 4.5 $1/$5, Sonnet $3/$15 za MTok; batch −50%, cache −90%)

**Dziennie (etap 2, 46 źródeł):**

| scenariusz | wejście | wyjście | koszt/dzień | koszt/mies |
|---|---|---|---|---|
| naiwny (wszystko codziennie) | ~350k tok | ~75k tok | $0.73 | ~$22 |
| **+ diff hash** (≈30% stron zmienia się dziennie) + followupy | ~130k | ~30k | $0.28 | ~$8.50 |
| + prompt caching + **Batch API** (−50%) | — | — | **$0.12** | **~$3.60** |

**Miesięcznie (etap 1):** 1 przebieg discover, ~13 gmin × 7 zapytań, triage Sonnetem ≈ **$2–4/przebieg**.

**Pozostałe:** geocoding Nominatim 0 zł (cache + 1 req/s), hosting GH Pages 0 zł, cron GH Actions 0 zł.
Plakaty JPG: ~10/dzień × ~1.5k tok obrazu ≈ $0.02/dzień.
Opcjonalnie FB (Apify facebook-events-scraper): ~$5–10/mies.

### Suma: **~$6–15/mies** (bez FB ~$6, z FB ~$15). Discovery wliczone.

## Digest (17:00): Telegram (aktywny) / email (w zapasie)

`src/digest.ts` + workflow `digest.yml` (cron 15:00 UTC = 17:00 CEST; zimą zmienić na 16).
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
`src/pii.ts` redaguje je tuż przed zapisem — `events.json`, `index.html`, `runs.json`
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

## Znane ograniczenia / TODO

- FB: tylko publiczne strony przez scraper 3rd-party; grupy zamknięte poza zakresem (ban risk).
- Dedupe: heurystyka tytuł+data; LLM-owy dedupe (`DEDUPE_SYSTEM`) gotowy w prompts.ts, niepodpięty.
- Weryfikacja URL-i: `discover --verify` (miesięczny cron `discover.yml`) sprawdza każdy URL, naprawia
  przez search+LLM (historia w `previous_urls`), nienaprawialne znakuje `dead:true` (daily pomija jako
  `skipped-dead` do następnej udanej naprawy).
- Tagi zagnieżdżone (`dzieci:dmuchańce`, `warsztaty:ceramika`) generuje prompt — słownik warto ustabilizować po ~2 tyg. danych.
- Powiadomienia: dodać `src/digest.ts` (czwartek 17:00, filtr wiek+weekend → mail/Telegram) — trywialne rozszerzenie.
- Walidacja odpowiedzi LLM: typy są rzutowane (`as ExtractionResult`); produkcyjnie warto dodać `zod` schema → `EventItem`.
