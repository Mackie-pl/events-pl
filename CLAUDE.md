# Zasady pracy w events-pl

Reguły, które wracają w kółko. Szczegóły i pomiary są w `README.md`, otwarte wątki w `TODO.md` —
tutaj tylko to, czym mam się kierować, zanim zacznę pisać kod.

## Faza projektu

- **PoC, nic nie działa produkcyjnie.** Nie piszę migracji, wstecznej zgodności ani fallbacków
  „bo starsze przebiegi tego nie mają". Zmiana psuje dane → kasujemy dane. Wyjątek: kasowanie
  z realnym kosztem (płatna re-ekstrakcja) zgłaszam i decyduje właściciel. Dotyczy to NASZYCH
  starych kształtów — nie zjawisk w świecie, patrz sekcja niżej.
- **Wystarczająco dobrze.** Kompletność rejestru i jakość pojedynczego digestu nie są warte
  nadkładania pracy. Zauważoną lukę albo stratę zgłaszam **jednym zdaniem i idę dalej** — bez
  planu naprawy danych, bez pytań blokujących.
- **Danych nie dłubiemy ręcznie.** Problem w `sources.json` / `state.json` / `events.json` naprawia
  następny przebieg, nie edytor. Ścieżka: test w `test/live/*.live.ts` nazywający złamaną regułę →
  poprawka POTOKU. Komunikat porażki kończy się linią `POTOK:` z konkretną propozycją.

## Systemy, nie łatki

Budujemy rzecz, która ma skalować się **bez nadzoru nad każdym wierszem danych**. To jest sito,
przez które przechodzi każda poprawka.

- **Poprawka celuje w ZJAWISKO, nie w rekord.** Widzę zły wynik na jednym źródle → szukam reguły,
  która załatwi też sto następnych przypadków, których nikt nigdy nie obejrzy. Pytanie kontrolne:
  „co ta zmiana robi przy 200 źródłach, gdy nikt nie czyta wierszy?".
- **Zero list wyjątków per źródło.** `if (source.id === "…")` w potoku to sygnał, że nie rozpoznałem
  reguły, tylko objaw. Geocoder dostał nazwę potoczną, sklejone nazwy i „ul" bez kropki zamiast wpisu
  na Cytadelę; FB dostał „blok = post" zamiast łatki na 142 źle pocięte posty z 356.
- **Mechanizm ma się leczyć sam także w przyszłości** — czyli sam wykryć, sam zareagować i sam wrócić
  do pomiaru, bez człowieka w pętli. Tak działa licznik grup niedostępnych (`FB_GROUP_BLOCKED_LIMIT`,
  jeden post zeruje serię, sonda co `FB_GROUP_BLOCKED_RECHECK_DAYS`), wygasające wyciszenie
  (`FB_MUTE_DAYS`), naprawa martwego URL-a przez search i regulator limitu liczony z pokrycia.
  Stan „raz zapadł, na zawsze" jest błędem projektowym: świat się zmienia, a nikt tego nie sprawdzi.
- **Ręczne domknięcie to nie rozwiązanie.** Jeśli poprawka wymaga, żebym po każdym przebiegu coś
  obejrzał, przekliknął albo odpalił — nie jest skończona, a najwyżej zdiagnozowana.
- **Wyjątek: zatruty pojedynczy rekord.** Wieczny błędny `null` w cache'u, jeden rekord z martwego
  kontraktu — kasujemy wpis i tyle. Budowanie maszynerii pod jeden zatruty wiersz to ta sama pomyłka
  od drugiej strony. To NIE jest sprzeczność z regułą wyżej: leczymy powtarzalne zjawisko
  (polska odmiana, udostępnienia, login wall, ucięta odpowiedź), a nie własne stare dane.

## Pieniądze

- **Optymalizujemy koszt, nie pokrycie.** 100% wydarzeń i tak nie złapiemy, więc „więcej danych za
  więcej pieniędzy" nie jest samo w sobie argumentem. Budżet: `COST_MONTHLY_BUDGET_USD` (dziś $15).
- **Każde płatne API dostaje twardy limit w tym samym commicie, w którym powstaje** — cap na rekordy
  po stronie dostawcy **i** cancel/cleanup na KAŻDEJ ścieżce porzucenia (timeout, wyjątek, wyjście
  z procesu). Sam `throw` nie zatrzymuje licznika u dostawcy — to była awaria z 2026-08-10 ($8 za
  10 h porzuconej migawki). Pętla po źródłach kupująca rekordy wymaga jawnej flagi (`--go`).
- Mechanizm sterujący wydatkiem może go **wyłącznie zmniejszać**. Pętla sama podnosząca limit
  u dostawcy per-rekord to dokładnie ten kształt awarii.
- Przebiegi rzędu centów odpalam bez pytania; rzędu dolarów (`discover -- "Poznań" 15`, ~$2–4)
  **zapowiadam przed uruchomieniem**.
- **Nie proponuję kolejnej rundy strojenia progów FB** — policzone i świadomie odrzucone
  (wszystkie pokrętła kosztują ~$0.20/mies. za punkt pokrycia). Lepsze rozwiązanie musi zmienić
  kształt problemu, nie przesunąć próg.
- Kategorie o stawce zero też zapisujemy, z wolumenem. Szacunek (`stawka × wolumen`) jest znaczony
  `~` i **nigdy nie awansuje po cichu na kwotę od dostawcy**.

## Obserwowalność

- **Każda decyzja potoku zostawia ślad.** Zmiana, która działa, ale nic o sobie nie mówi, jest tu
  niepełna — przy kilkudziesięciu źródłach ślad jest jedyną drogą do „czemu to źródło nic nie dało".
- Nowy rodzaj decyzji = nowa pozycja w `AuditKind` (`src/types/audit.ts`), dopisana w **trzech**
  miejscach: tam, w `panel/src/app/types-audit.ts` i w `STEP_META` (`panel/src/app/format.ts`).
  Nowe pole w `SourceRun` mirroruję w `panel/src/app/types.ts`.
- Notka śladu to **decyzja po polsku, jedno zdanie** („wracamy na stronę i model"), nie `fallback=true`.
- Liczę też to, co ODPADŁO, i osobno powody. „8 rekordów → 3 wydarzenia" bez rozbicia to zagadka.
- Ścieżka, która oszczędza pieniądze, ma to **udowadniać w raporcie** (`llm.calls === 0` przy
  `events > 0`), a nie w komentarzu.
- **Pomiar przed pokrętłem.** Zmiana, która „wygląda lepiej", ale nie ma liczby, jest zgadywaniem —
  i tak wygląda cały sierpień 2026 (patrz `TODO.md` §1). Nowy próg najpierw mierzy, potem steruje.

## Typy i jakość

- **Cel: pełna type-safety.** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`;
  `npm run typecheck` obejmuje `src/` i `test/`. Nie obchodzę tego przez `any`, `as` ani
  `// eslint-disable` — martwe dyrektywy wywracają CI z założenia.
- Progi rozmiaru z `eslint.shared.js` są twarde: 350 linii kodu na plik, 120 znaków na linię,
  zagnieżdżenie ≤ 4, ≤ 4 parametry. **Podnoszenie progu „żeby było zielono" mija się z celem.**
  Liczone bez komentarzy — gęsty polski JSDoc to dokumentacja decyzji, nie dług.
- Bramki: `pre-commit` = typecheck + lint, `pre-push` = `npm test`, CI = wszystko troje + panel.
  Dokładając plik, na który patrzą testy, dopisuję go do filtra `paths` w `ci.yml` — inaczej
  czerwone testy przeleżą w `main` tydzień (tak było z `config.json`).

## Programowanie defensywne

- **Nieufność należy się ŚWIATU, nie naszym wczorajszym danym.** Odpowiedź LLM, HTML źródła, rekord
  Bright Data, odpowiedź dostawcy — walidujemy, nie rzutujemy: rekord bez URL-a odpada, nieznane
  `type`/`fetch` normalizujemy, kolizja `id` dostaje sufiks (`id` jest kluczem cache'u, więc duplikat
  cicho scaliłby dwa różne źródła). To jedyny wyjątek od „bez kodu na cudze kształty" — tamto dotyczy
  NASZYCH starych plików, nie cudzych odpowiedzi.
- **Fail closed.** Gdy nie wiem, wybieram wariant, który nie szkodzi: 9-cyfrowy numer o nieznanym
  prefiksie jest usuwany, parowanie fanpage'a ze stroną jest celowo ostrożne. Rozstrzyga **asymetria
  błędu**, nie trafność średnio: fałszywe „covered" znaczy, że goldmine nigdy nie zostanie zmierzony
  i nikt się nie dowie; fałszywe „do sondy" kosztuje $0.03 i widać je w tabeli.
- **Cicha porażka jest droższa niż głośna.** Złapany wyjątek zwracający pustą listę wygląda dokładnie
  jak strona bez wydarzeń — trzy portale stały tak przez pięć przebiegów po ~$0.49 dziennie za zero.
  Każdy tryb porażki ma własny status (`truncated` ≠ `bad-json` ≠ `empty`), nigdy wspólne „zero".
- **Wyjątek nie kasuje opłaconego wyniku.** Raport i zmiany zapisują się także po wyjątku
  (`partial: true` + `err`), awaria jednego źródła nie przerywa reszty, a z uszkodzonej odpowiedzi
  ratujemy kompletne rekordy (`shared/json-salvage.ts`) zamiast oddać wszystko do kosza.
- **Potknięcie ≠ stan trwały**, a rozróżnia to dostawca, nie moje zgadywanie w fasadzie: werdykt
  wraca z adaptera (`SearchProviderOutcome.fatal`), 5xx/429 idzie w ponowienie, a nie w ciche
  zejście do gorszego wyniku, które potem wygląda jak „brak danych".
- **Bezpiecznik tam, gdzie pomyłka kasuje źródło, a nie wiersz w raporcie**: mechanizm wyciszający
  wymaga jawnej zmiennej (bez niej nie działa), minimum realnych przebiegów, wygasania i podłogi.

## Testy na prawdziwych danych

- **Atrapa opisuje kształt, nigdy zachowanie wejścia.** `test/helpers.ts` buduje `EventItem`, żeby
  test nie był ścianą szumu — ale HTML, odpowiedź modelu i rekord dostawcy mają być **prawdziwe**:
  `test/fixtures/` trzyma strony pobrane z sieci i takie mają zostać. Wymyślony HTML dowodzi
  wyłącznie tego, że mój wymyślony HTML przechodzi.
- **Błąd z żywych danych zaczyna się od przypadku z żywych danych.** Przycinam prawdziwą odpowiedź
  albo stronę do fixtury/asercji i zostawiam w komentarzu datę i źródło — po to, żeby za miesiąc
  było wiadomo, czy przypadek jeszcze istnieje.
- **Dwa zestawy, dwie role.** `npm test` waliduje KOD i musi być zielony, żeby dało się pracować;
  `npm run test:live` waliduje STAN DANYCH w repo i ma prawo świecić na czerwono aż do najbliższego
  przebiegu. Dlatego live jest osobnym skryptem i **nie wywraca CI** — jedno zepsute źródło nie może
  zatrzymać pracy. Każda asercja live opisuje REGUŁĘ, nie stan konkretnego źródła, i kończy się
  linią `POTOK:` z konkretną propozycją zmiany.
- **Nie ma darmowej wyroczni → nie udaję testu.** Czego nie da się sprawdzić bez płatnego przebiegu
  (orkiestratory `run`/`collect`/`chat`/`discoverTown`/`processSource`), zostaje ostrzeżeniem
  z uzasadnieniem w `eslint.shared.js` — nie mockiem, który zielenieje, nie wiedząc o niczym.
  Darmowe wyrocznie offline: `discover --why`, dry-run digestu, `backfill-costs -- --force`.
- **Pomiar z udziałem modelu wymaga powtórek.** `temperature` różna od zera znaczy, że jeden przebieg
  na wariant mierzy wariancję, a nie efekt zmiany.

## Architektura

- `src/actions/` = `main()` + orkiestracja, **zero logiki dziedzinowej** · `src/pipeline/` = domena ·
  `src/adapters/` = wyjścia do świata · `src/shared/` = narzędzia bez zależności ·
  `src/storage/` = **jedyne miejsce znające ścieżki** (port `DocStore`/`CollectionStore`).
- **Zostajemy przy GitHub/JSON** — bez Supabase jako backendu, dopóki nie zajdzie któryś z warunków
  z `supabase-not-yet` (przebiegi z wdrożonego panelu, kolizje zapisu, panel dławiący się plikami).
- **Jedno źródło prawdy.** `types/event-schema.ts` daje naraz typ, blok schematu w prompcie
  i `response_format`. Powielony kształt rozjeżdża się — tak było, zanim to scaliliśmy.
- **Konfiguracja tylko przez `src/config/params.ts`** (pilnuje tego test). Nowy parametr: wpis
  w rejestrze → `npm run config:docs` (przebudowuje tabelę w README, `.env.example` i klucze
  w `config.json`). Progi siedzą w commitowanym `config.json`, bo próg zmieniony w sekretach
  nie zostawia śladu — a `git log -p config.json` odpowiada „od kiedy".
- **Repo jest publiczne.** PII redagujemy tuż przed zapisem (`src/pipeline/pii.ts`); surowe treści,
  prompty i wydarzenia sprzed redakcji idą wyłącznie do prywatnego archiwum.

## Praca

- **Piszę po polsku**: komentarze, JSDoc, komunikaty CLI, notki śladu, komunikaty commitów.
  Komentarz w tym repo tłumaczy DECYZJĘ (z datą i liczbą, jeśli była mierzona), nie składnię —
  taki komentarz zostaje, nawet gdy kod wokół się zmienia.
- Rzecz rozstrzygnięta trafia do README i do komentarza przy kodzie; nierozstrzygnięta — do `TODO.md`.
  Zamykając wpis z TODO, przenoszę uzasadnienie do kodu i kasuję go stamtąd.
- **Windows / PowerShell.** `VAR=... npm run x` i `export VAR=...` to składnia bash-a i tu nie działa.
  Konfiguracja idzie przez `.env` (skrypty wczytują go same), doraźnie `$env:NAZWA = "..."`.
- Uwaga na skrypty z efektem: `npm run digest` przy ustawionym `TELEGRAM_BOT_TOKEN` **naprawdę wyśle** —
  do podglądu `npx tsx src/actions/digest.ts` bez `--env-file`.
