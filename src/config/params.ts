/**
 * REJESTR PARAMETRÓW — jedyne miejsce, w którym potok czyta środowisko.
 *
 * Każda zmienna ma tu dokładnie jeden wpis: nazwę (z klucza), typ, wartość domyślną i prozę
 * mówiącą PO CO ona jest. Z tego samego wpisu bierze się `.env.example` ORAZ tabela w README
 * (`npm run config:docs`), więc dokumentacja nie może się rozjechać z kodem — pilnuje tego test.
 *
 * Wcześniej te 55 zmiennych mieszkało w 52 miejscach naraz, każde z własną wartością domyślną
 * wpisaną w wyrażenie (`Number(process.env["EXTRACT_MAX_TOKENS"] ?? 12_000)`) i własnym,
 * lekko innym parserem — ten sam pomocnik `num()` był skopiowany do trzech plików, a w
 * czwartym miał inne zasady walidacji. Na pytanie „jakie są pokrętła i co jest ustawione"
 * nie odpowiadało nic.
 *
 * DOPISUJĄC PARAMETR: wpis tutaj, potem `npm run config:docs`. Nic więcej — plik przykładowy
 * i README nadążą same.
 *
 * DWA POLA OPISU, bo odpowiadają na dwa różne pytania: `summary` (wymagane, jedna linia) mówi
 * CO parametr robi i trafia do obu dokumentów; `doc` (opcjonalne) mówi DLACZEGO akurat tak
 * i zostaje w .env.example, bo tam czyta je ten, kto właśnie ma coś ustawić.
 *
 * Klasy (`cls`) nie są ozdobą: `tuning` to progi sterujące zachowaniem potoku i to one pojadą
 * kiedyś do wersjonowanego `config.json`, żeby zmiana progu zostawiała ślad w historii repo.
 * `secret` nigdy nie może tam trafić.
 */
import { csv, defineParams, num, offWhenZero, oneOf, optText, posNum, text } from "./param.js";
import type { Param } from "./param.js";
import { FB_PARAMS } from "./params-fb.js";
import { OUTPUT_PARAMS } from "./params-outputs.js";

export const P = defineParams({
  // --- llm ---
  OPENROUTER_API_KEY: optText({
    group: "llm", cls: "secret", fill: true, example: "sk-or-...",
    summary: "klucz do OpenRoutera — bez niego nie ruszy ani ekstrakcja, ani discovery",
  }),

  // --- search ---
  SERPER_API_KEY: optText({
    group: "search", cls: "secret", fill: true,
    summary: "klucz Serpera — bez niego discovery i naprawa martwych URL-i nie działają",
    doc: [
      "Domyślnie Serper (serper.dev): wyniki Google bez Google Programmable Search, które od",
      "lipca 2026 nie przyjmuje nowych klientów. Darmowe 2500 zapytań na start.",
      "Klucz idzie nagłówkiem X-API-KEY, nigdy w URL-u — discover-runs.json trafia do repo.",
    ],
  }),
  SEARCH_PROVIDER: oneOf({
    group: "search", cls: "setting", values: ["serper", "google", "brave"], def: "serper",
    summary: "serper (domyślnie) | google | brave",
  }),
  GOOGLE_API_KEY: optText({
    group: "search", cls: "secret",
    summary: "tylko dla SEARCH_PROVIDER=google (konta sprzed 07.2026)",
  }),
  GOOGLE_CSE_CX: optText({
    group: "search", cls: "setting",
    summary: "id silnika; MUSI mieć włączone „Search the entire web”",
  }),
  BRAVE_API_KEY: optText({
    group: "search", cls: "secret",
    summary: "tylko dla SEARCH_PROVIDER=brave (2000 zapytań/mies. gratis)",
  }),
  DISCOVER_MAX_SEARCHES: num({
    group: "search", cls: "tuning", def: 300, min: 0,
    summary: "sufit zapytań do wyszukiwarki na jeden przebieg discovery",
    doc: [
      "bezpiecznik limitu: po tylu zapytaniach przebieg przestaje odpytywać wyszukiwarkę",
      "(~10 zapytań na gminę: Poznań +15 km to ~130, Warszawa z dzielnicami 200+; darmowa pula",
      "Serpera to 2500, czyli kilkanaście pełnych przebiegów; pominięte lądują w raporcie jako skipped)",
    ],
  }),

  // --- models ---
  MODEL_EXTRACT: text({
    group: "models", cls: "setting", def: "anthropic/claude-haiku-4.5",
    summary: "model codziennej ekstrakcji — musi umieć obrazy i JSON po polsku",
  }),
  MODEL_DISCOVER: text({
    group: "models", cls: "setting", def: "anthropic/claude-sonnet-4.6",
    summary: "model miesięcznego discovery — mocniejszy, bo ocenia trafienia wyszukiwarki",
  }),

  // --- structured ---
  STRUCTURED_OUTPUTS: offWhenZero({
    group: "structured", cls: "setting", example: "0",
    summary: "`0` wyłącza wymuszony JSON Schema na odpowiedzi modelu",
    doc: [
      "Wymusza na modelu kształt z src/types/event-schema.ts zamiast prosić o niego w prompcie.",
      "Obsługa zależy nie od samego modelu, tylko od ENDPOINTU: ten sam model OpenRouter serwuje",
      "z kilku źródeł (Anthropic, Azure, Bedrock…) i tylko część z nich przyjmuje response_format.",
      "Przy schemacie dokładamy `provider.require_parameters`, żeby routing omijał te bez obsługi —",
      "inaczej dostaje się losowe 400 wyglądające na błąd schematu.",
      "Zanim zmienisz, sprawdź jednym płatnym wywołaniem: npm run check:structured",
      "Gdyby model jednak odbił schemat, przebieg się nie wywraca — leci dalej bez niego.",
      "",
      "UWAGA NA KOSZT. Schemat leci w KAŻDYM requeście i nie jest darmowy. Pomiar sondą",
      "2026-07-28, ta sama treść i ten sam prompt, Haiku 4.5:",
      "  bez schematu:  937 tok wejścia + 286 wyjścia",
      "  ze schematem: 3222 tok wejścia + 173 wyjścia   (~3,4× wejście)",
      "Narzut jest STAŁY (~2300 tok), więc przy realnej ekstrakcji (9-14k tok wejścia) to ~+20%,",
      "rząd +$3/mies. przy 46 źródłach dziennie.",
      "",
      "Od 2026-08-01 WŁĄCZONE DOMYŚLNIE — narzut kupuje poprawność, nie wygodę. Bez schematu model",
      "przepisuje typografię strony i wypuszcza `\"title\": \"Spacer „Okrąglak\" z ...\"` (polski",
      "cudzysłów otwierający, ASCII zamykający), co urywa string JSON-a w środku wartości.",
      "Pomiar na estrada.poznan.pl: 8 wydarzeń bez schematu, 25 z nim.",
      "",
      "Odkomentuj, żeby WYŁĄCZYĆ:",
    ],
  }),
  STRUCTURED_IGNORE_PROVIDERS: csv({
    group: "structured", cls: "setting", def: ["azure"],
    summary: "dostawcy OpenRoutera pomijani na ścieżce ze schematem (po przecinku)",
    doc: [
      "Dostawcy pomijani przy schemacie (slugi OpenRoutera, po przecinku). Domyślnie `azure`:",
      'deklaruje obsługę response_format, ale odbija ją na poziomie konta („structured_outputs',
      'not supported in your workspace"), czego require_parameters nie wyłapie. Wyczyść wartość,',
      "jeśli Twój workspace Azure ma to uprawnienie.",
    ],
  }),

  // --- fb: kanał Facebook, patrz params-fb.ts ---
  ...FB_PARAMS,

  // --- pipeline ---
  EXTRACT_MAX_TOKENS: posNum({
    group: "pipeline", cls: "tuning", def: 12_000,
    summary: "sufit tokenów odpowiedzi przy ekstrakcji wydarzeń",
    doc: [
      "Sufit tokenów wyjścia jednego wywołania. Obciętą odpowiedź ratuje json-salvage,",
      "ale ratunek gubi ogon listy — strona z pełnym kalendarium traci najdalsze terminy.",
    ],
  }),
  DISCOVER_MAX_TOKENS: posNum({
    group: "pipeline", cls: "tuning", def: 12_000,
    summary: "sufit tokenów odpowiedzi przy ocenie trafień wyszukiwarki",
  }),
  BLOCK_MAX_CALLS: num({
    group: "pipeline", cls: "tuning", def: 80, min: 0,
    summary: "sufit wywołań LLM na blokowanie źródeł w przebiegu (0 = nie wołaj)",
  }),
  REPERTOIRE_URL_SEGMENTS: csv({
    group: "pipeline", cls: "tuning",
    def: ["seances", "seanse", "repertuar", "repertoire", "showtimes", "seansy"],
    summary: "segmenty ścieżki znaczące repertuar — takich adresów nie czytamy (po przecinku)",
    doc: [
      "Adres, którego SEGMENT ścieżki równa się któremuś z tych słów, jest repertuarem kina",
      "albo teatru: ten sam tytuł ×N dziennie, jutro znowu ×N z innymi godzinami. Nie wchodzimy",
      "tam ani entrypointem, ani followupem — patrz src/pipeline/repertoire.ts po pomiary.",
      "Dopasowanie jest po CAŁYM segmencie, więc slug `…-seans-kina-plenerowego-la-chimera`",
      "(prawdziwe wydarzenie) zostaje, a `/mim/events/seances/` odpada.",
      "Pusta wartość wyłącza regułę.",
    ],
  }),
  PAGER_PROBE_RECHECK_DAYS: num({
    group: "pipeline", cls: "tuning", def: 14, min: 1,
    summary: "co ile dni ponawiamy sondę nazwy parametru paginacji (pager bez adresów)",
    doc: [
      "Dotyczy listingów, których pager nie niesie adresów, bo numer dokłada JS (okpoznan.pl).",
      "Sonda zgaduje nazwę parametru i SPRAWDZA ją za darmo — patrz extract/pager-probe.ts.",
      "Werdykt, także odmowny, zapamiętujemy: bez tego pięć pobrań u cudzego serwisu wracałoby",
      "w każdym przebiegu. Wygasanie liczone przy odczycie, więc zmiana progu działa od razu,",
      "a serwis przebudowany w międzyczasie odnajduje się sam.",
    ],
  }),
  LISTING_PAGES_MAX: num({
    group: "pipeline", cls: "tuning", def: 3, min: 1,
    summary: "ile stron listingu czytamy przy jednym źródle (1 = tylko pierwsza, czyli jak dotąd)",
    doc: [
      "Paginacja listingu, NIE followup: strona 2 jest dalszym ciągiem tej samej listy, więc ma",
      "własny sufit i nie zabiera slotu podstronom wydarzeń (FOLLOWUPS_PER_SOURCE).",
      "Adres kolejnej strony CZYTAMY z pagera (src/pipeline/extract/paginate.ts), nie zgadujemy",
      "z nazwy parametru — pomiar 2026-08-20 na 35 źródłach dał pięć konwencji naraz, w tym",
      "`?pno=` i `?ccm_paging_p=`, których żadna lista nazw by nie przewidziała.",
      "Trójka, bo dalej rzadko stoi cokolwiek przyszłego: na stronach 2 zmierzonych 2026-08-20",
      "przyszłe terminy miały mosina (2 z 3), puszczykowo (6 z 6) i poznan.pl (21 z 22),",
      "a biblub.com ZERO — jego strona 2 to archiwum 2024-06…2026-05.",
      "Sufit jest hamulcem, nie regulatorem: chodzenie kończy się wcześniej, gdy strona nie ma",
      "przyszłych terminów (darmowa sonda po datach) albo nie oddała ani jednego wydarzenia.",
    ],
  }),
  FOLLOWUPS_PER_SOURCE: num({
    group: "pipeline", cls: "tuning", def: 7, min: 0,
    summary: "ile podstron / PDF-ów / plakatów dociągamy przy jednym źródle (0 = wcale)",
    doc: [
      "Ta sama liczba jedzie do PROMPTU („Maks N followupów\") i do przycięcia kolejki — inaczej",
      "pokrętło jest martwe: model trzymał się swojej piątki, więc podniesienie samego limitu",
      "w kodzie nie zmieniało niczego poza tym, że wejście z etapu 1 przestawało wypychać ogon.",
      "Podniesione z 5 na 7 dnia 2026-08-19, bez pomiaru — okpoznan.pl/wydarzenia ma 16 realnych",
      "kart i przy piątce siedem z nich nie miało jak zostać przeczytane. Followup niezmieniony",
      "od wczoraj nie kosztuje wywołania modelu (hash treści), więc cena rośnie tylko o PIERWSZE",
      "przeczytanie każdej nowej podstrony — rzędu $0.001 za sztukę.",
      "Sonda kontenerów (CONTAINER_MAX_PROBES) ma własny sufit i liczy się osobno.",
      "Kolejność: podstrony wpisów bez miejsca albo bez godziny idą pierwsze —",
      "patrz src/pipeline/extract/followup-queue.ts.",
    ],
  }),
  FOLLOWUP_SAME_PAGE_RECHECK_DAYS: num({
    group: "pipeline", cls: "tuning", def: 30, min: 0,
    summary: "po ilu dniach followup identyczny ze stroną źródła wraca do kolejki (0 = pyta zawsze)",
    doc: [
      "Część adresów oddaje bajt w bajt tę samą treść, co strona źródła: mosina.pl/wydarzenia",
      "i …?page=1 to te same 406 940 bajtów, czerwonak.pl/mieszkaniec/kalendarz to samo, co",
      "/pl/mieszkaniec/kalendarz. Potok wykrywał to od dawna, ale dopiero PO zużyciu slotu",
      "— stale 2 takie followupy dziennie, każdy kosztem jednego wydarzenia, którego nie",
      "przeczytaliśmy. Teraz taki adres nie wchodzi do kolejki przez tyle dni.",
      "Zero wyłącza pamięć: adres pytany w każdym przebiegu, tak jak przed 2026-08-19.",
      "Wpis WYGASA celowo — serwis może kiedyś rozdzielić paginację i nikt nam tego nie zgłosi.",
    ],
  }),
  FOLLOWUP_HOST_LIMIT: num({
    group: "pipeline", cls: "tuning", def: 3, min: 0,
    summary: "po ilu przebiegach bez opublikowanego wydarzenia obcy serwis wypada z kolejki "
      + "followupów (0 = mechanizm wyłączony)",
    doc: [
      "Followup potrafi wyjść poza serwis źródła: udostępniony post odesłał potok na katalog",
      "biura podróży st.pl (2026-08-21). Kosztował $0.0104, czyli więcej niż cała strona źródła,",
      "i oddał 38 „wydarzeń”, z których do publikacji nie weszło ANI JEDNO.",
      "Plon liczymy PO publikacji, nie po ekstrakcji — po liczbie wyciągniętych rekordów ten",
      "katalog był najlepszym followupem przebiegu. Dopiero pytanie „ile z tego czytelnik",
      "zobaczył” (po odsiewie i scalaniu duplikatów) odróżnia go od podstrony domu kultury.",
      "Seria, nie pojedynczy dzień: podstrona bywa pusta w poniedziałek i pełna w piątek.",
      "Jedno opublikowane wydarzenie zeruje licznik. Hosty z rejestru źródeł i podstrony",
      "własnego serwisu źródła NIE są liczone — patrz pipeline/extract/followup-hosts.ts.",
    ],
  }),
  FOLLOWUP_HOST_RECHECK_DAYS: num({
    group: "pipeline", cls: "tuning", def: 30, min: 0,
    summary: "po ilu dniach wyciszony serwis wraca do kolejki followupów na próbę",
    doc: [
      "Wyciszenie MUSI wygasać: serwis może zacząć publikować coś z naszego regionu, a nikt",
      "nam tego nie zgłosi. Stan „raz zapadł, na zawsze” jest błędem projektowym — ta sama",
      "zasada, co przy grupach FB (FB_GROUP_BLOCKED_RECHECK_DAYS) i wyciszeniu kosztowym.",
      "Sonda kosztuje jedno pobranie i jedno wywołanie modelu, czyli rzędu $0.001.",
      "Ta sama liczba przycina wpisy o PRZERWANEJ serii: host odwiedzony raz i nigdy więcej",
      "wypada ze state.json, zamiast puchnąć w commitowanym pliku bez końca.",
    ],
  }),
  CONTAINER_MIN_SPAN_DAYS: num({
    group: "pipeline", cls: "tuning", def: 8, min: 0,
    summary: "od ilu dni zakres bez rytmu i bez godziny uznajemy za stronę programu (0 = nie sonduj)",
    doc: [
      "Wpis rozciągnięty na tyle dni, bez `repeat` i bez godziny startu, jest podejrzany",
      "o bycie KONTENEREM: kartą listingu prowadzącą do strony z programem, a nie wydarzeniem.",
      "Próg 8 dni wzięty z pomiaru na events.json 2026-08-18: festiwale i zjazdy mieszczą się",
      "w 2–7 dniach, a wszystko powyżej to albo program (SIERPIEŃ 2026 W ZAMKU, Akcja Lato",
      "z Biblioteką), albo wystawa czynna miesiącami. Patrz src/pipeline/extract/container.ts.",
      "Zero wyłącza sondę — wpisy zostają takie, jakie przyszły od modelu.",
    ],
  }),
  CONTAINER_MAX_PROBES: num({
    group: "pipeline", cls: "tuning", def: 3, min: 0,
    summary: "ile stron-programów sondujemy w jednym źródle na przebieg",
    doc: [
      "Sufit LICZONY OSOBNO od followupów modelu, bo odpowiada na inne pytanie i nie ma prawa",
      "wypchnąć adresu, który model wskazał jawnie. Nadwyżka czeka na kolejny przebieg:",
      "kolejność sondowania stawia adresy nigdy niepobrane przed tymi, które mają już wpis",
      "w cache'u followupów, więc źródło z sześcioma podejrzanymi przerabia je w dwa przebiegi.",
      "Ponowna sonda niezmienionej strony nie kosztuje wywołania modelu — sam fetch i hash.",
    ],
  }),
  ENTRYPOINT_LLM: oneOf({
    group: "pipeline", cls: "tuning", values: ["always", "ambiguous", "never"], def: "always",
    summary: "kiedy pytać model o punkt wejścia gminy: always | ambiguous | never",
    doc: [
      "`ambiguous` pyta tylko wtedy, gdy sam pomiar nie wskazał wyraźnego zwycięzcy, `never`",
      "zostawia decyzję pomiarowi i nie kosztuje ani jednego wywołania LLM.",
    ],
  }),

  // --- archive ---
  SUPABASE_URL: optText({
    group: "archive", cls: "setting", fill: true, example: "https://xxxxxxxx.supabase.co",
    summary: "adres projektu Supabase; brak = archiwum wyłączone, reszta działa",
    doc: [
      "Settings → API Keys → **Secret key** (sb_secret_…), NIE Publishable (sb_publishable_…).",
      "Supabase przemianował klucze: Secret = dawny service_role, Publishable = dawny anon.",
      "Ten klucz omija RLS: tylko backend/Actions/lokalny most, NIGDY panel ani frontend.",
    ],
  }),
  SUPABASE_SECRET_KEY: optText({
    group: "archive", cls: "secret", fill: true,
    summary: "klucz Secret (sb_secret_…), NIE Publishable — omija RLS",
  }),
  SUPABASE_SERVICE_ROLE_KEY: optText({
    group: "archive", cls: "secret",
    summary: "dawna nazwa tego samego klucza (projekty z JWT eyJ…)",
  }),
  SUPABASE_BUCKET: text({
    group: "archive", cls: "setting", def: "archive", summary: "bucket archiwum treści",
  }),
  ARCHIVE_RETENTION_DAYS: posNum({
    group: "archive", cls: "tuning", def: 90,
    summary: "po tylu dniach obiekty archiwum idą do skasowania",
  }),
  ARCHIVE_PORT: posNum({
    group: "archive", cls: "setting", def: 8787,
    summary: "port lokalnego mostu panelu (npm run panel-server)",
  }),

  // --- costs ---
  COST_MONTHLY_BUDGET_USD: num({
    group: "costs", cls: "tuning", def: 15, min: 0,
    summary: "linia odniesienia w panelu (nie limit twardy)",
    doc: [
      "LLM podaje kwotę sam (OpenRouter zwraca `cost` przy każdym wywołaniu) — reszta jest",
      "liczona jako wolumen × stawka i tak też oznaczona w panelu (`~`). Zmiana stawki nie",
      "przelicza starych wpisów: księga zapisuje stawkę obowiązującą w momencie przebiegu.",
    ],
  }),
  COST_RETENTION_DAYS: posNum({
    group: "costs", cls: "tuning", def: 90,
    summary: "ile dni kwot trzyma księga (runs.json trzyma 7 dni szczegółów)",
  }),
  BD_COST_PER_RECORD: num({
    group: "costs", cls: "tuning", def: 0.0015, min: 0,
    summary: "stawka Bright Data za rekord (potwierdź w panelu BD)",
  }),
  SEARCH_COST_PER_QUERY: num({
    group: "costs", cls: "tuning", def: 0.001, min: 0,
    summary: "stawka za zapytanie: Serper ~0.001, Google 0.005, Brave 0",
  }),
  SUPABASE_COST_PER_GB_MONTH: num({
    group: "costs", cls: "tuning", def: 0, min: 0,
    summary: "stawka za GB archiwum na miesiąc (darmowy tier ~1 GB)",
  }),
  SCRAPE_COST_PER_FETCH: num({
    group: "costs", cls: "tuning", def: 0, min: 0,
    summary: "stawka za pobranie strony (GH Actions dla repo publicznego: 0)",
  }),

  // --- digest + endpoints: wyjścia do świata, patrz params-outputs.ts ---
  ...OUTPUT_PARAMS,

  // --- pipeline (c.d.): wyłącznik warstwy pliku ---
  CONFIG_FILE: offWhenZero({
    group: "pipeline", cls: "setting", example: "0",
    summary: "`0` ignoruje config.json — przebieg na samych wartościach domyślnych",
    doc: [
      'Env nadpisuje pojedynczy próg, ale nie umie go COFNĄĆ do „nieustawionego": pusta wartość',
      'znaczy „brak" i spada z powrotem na config.json. Ten wyłącznik zdejmuje całą warstwę pliku',
      "naraz — do sprawdzenia, jak potok zachowa się na domyślnych, bez ruszania commita.",
      "Z tego korzysta `npm test`: testy sprawdzają logikę przy progach, które same podają,",
      "a nie to, jak akurat nastrojony jest potok. Inaczej zmiana progu w config.json robiłaby",
      "czerwone testy w miejscach, które z tą zmianą nie mają nic wspólnego.",
    ],
  }),

  // --- ambient: nie renderują się do .env.example, bo nie my je ustawiamy ---
  GITHUB_ACTIONS: optText({
    group: "ambient", cls: "ambient", summary: "ustawia runner — po tym poznajemy, że jesteśmy w Actions",
  }),
  GITHUB_STEP_SUMMARY: optText({
    group: "ambient", cls: "ambient", summary: "ścieżka pliku job summary; poza Actions nie istnieje",
  }),
});

/** Wszystkie parametry w kolejności deklaracji — do renderowania i do zrzutów. */
export const ALL_PARAMS: readonly Param<unknown>[] = Object.values(P);
