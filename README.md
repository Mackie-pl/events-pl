# events-pl — agregator wydarzeń lokalnych (pipeline 2-etapowy, Node/TS, OpenRouter)

## Architektura

```
STAGE 1 (miesięcznie / nowe miasto)         STAGE 2 (codziennie)
─────────────────────────────────           ────────────────────────────────
miasto + promień                            sources.json
  → Overpass API (gminy w promieniu)          → fetch (plain/headless/pdf/api)
  → wyszukiwarka (Brave, darmowy tier)        → diff (hash) — pomijamy niezmienione
  → SONNET: triage kandydatów                 → HAIKU: ekstrakcja → JSON
  → sources.json                              → followups (1 hop): PDF-y programów,
                                                podstrony, plakaty JPG (vision)
src/discover.ts                               → geocode (Nominatim, darmowe, cache)
                                              → dedupe (heurystyka + LLM)
                                              → events.json → index.html
                                            src/daily.ts
```

## Pliki

| plik | rola |
|---|---|
| `sources.json` | rejestr źródeł Poznań +15 km (etap 1 wykonany ręcznie 2026-07-20; 46 źródeł, 13 gmin) |
| `src/types.ts` | pełne typy: Source, EventItem (age/price/sub_slots/tags/conditional), State |
| `src/discover.ts` | etap 1 (Sonnet + Brave Search + Overpass) |
| `src/daily.ts` | etap 2 (Haiku: ekstrakcja, kontenery, PDF przez `unpdf`, plakaty vision, geo, dedupe) |
| `src/prompts.ts` | prompty PL dla obu etapów |
| `template.html` | frontend (wiek dziecka, tagi zagnieżdżone, weekend, mapa OSM); `daily.ts` wstrzykuje JSON |

## Setup

```bash
npm install                     # Node >= 20; playwright jest opcjonalny
# strony JS-only (CK Zamek itp.):
npm install playwright && npx playwright install chromium

export OPENROUTER_API_KEY=sk-or-...
# opcjonalnie — ewaluacja innych modeli bez zmian w kodzie:
# export MODEL_EXTRACT=anthropic/claude-haiku-4.5      (default)
# export MODEL_DISCOVER=anthropic/claude-sonnet-4.6    (default)
# np. MODEL_EXTRACT=google/gemini-flash-... / openai/gpt-...-mini / mistralai/...
npm run daily                   # → events.json + index.html

# raz w miesiącu / nowe miasto:
export BRAVE_API_KEY=...        # darmowy tier: 2000 zapytań/mies
npm run discover -- "Poznań" 15

npm run typecheck               # tsc --noEmit (strict)
```

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
      - run: npm ci --omit=optional
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

## Digest mailowy (17:00)

`src/digest.ts` + workflow `digest.yml` (cron 15:00 UTC = 17:00 CEST; zimą zmienić na 16).
Logika dni: **pt** → sam WEEKEND (sob+nd) · **sob** → tylko JUTRO (nd) · **nd–czw** → JUTRO + najbliższy WEEKEND.
Rodzinne 👨‍👦 sortowane na górę; szum (komisje itp.) odfiltrowany.

Secrets: `RESEND_API_KEY` ([resend.com](https://resend.com) — darmowe 100 maili/dzień, wysyłka z `onboarding@resend.dev`
bez własnej domeny) + `DIGEST_TO` (twój adres). Opcjonalnie `DIGEST_CHILD_AGE=5` — filtr wg wieku dziecka.
Bez kluczy `npm run digest` robi dry-run na stdout.

## Znane ograniczenia / TODO

- FB: tylko publiczne strony przez scraper 3rd-party; grupy zamknięte poza zakresem (ban risk).
- Dedupe: heurystyka tytuł+data; LLM-owy dedupe (`DEDUPE_SYSTEM`) gotowy w prompts.ts, niepodpięty.
- `verified:false` w sources.json → pierwszy przebieg daily zweryfikuje URL-e (404 → flaga do re-discovery).
- Tagi zagnieżdżone (`dzieci:dmuchańce`, `warsztaty:ceramika`) generuje prompt — słownik warto ustabilizować po ~2 tyg. danych.
- Powiadomienia: dodać `src/digest.ts` (czwartek 17:00, filtr wiek+weekend → mail/Telegram) — trywialne rozszerzenie.
- Walidacja odpowiedzi LLM: typy są rzutowane (`as ExtractionResult`); produkcyjnie warto dodać `zod` schema → `EventItem`.
