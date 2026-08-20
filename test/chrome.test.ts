/**
 * Sito chromu: menu, zgody na ciasteczka, stopki i paski stron rozpoznawane BEZ modelu.
 *
 * Wszystkie teksty poniżej są PRAWDZIWE — przycięte z rejestru 2026-08-20, z podanym źródłem
 * przy każdym. Wymyślone menu dowodziłoby wyłącznie tego, że moje wymyślone menu przechodzi,
 * a cała teza tego modułu brzmi „polski chrom miejski ma zamknięte słownictwo i wspólny
 * kształt" — czyli jest twierdzeniem o świecie, nie o kodzie.
 *
 * Asercje idą parami: co MUSI zostać odsiane i co NIE MOŻE. Druga połowa jest ważniejsza,
 * bo tu decyduje asymetria błędu — fałszywe „to chrom" kasuje wydarzenie bez śladu, fałszywe
 * „to treść" kosztuje ułamek centa i widać je w tabeli.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { chromeShare, looksLikeChrome } from "../src/pipeline/extract/chrome.js";
import { paragraphs, toBlock } from "../src/pipeline/extract/blocks.js";
import { partitionChrome } from "../src/pipeline/extract/block-source.js";

/** jck-poznan.pl, 2026-08-20 — baner zgody, najczystszy chrom, jaki jest */
const COOKIE = "Ta strona korzysta z plików cookie, aby poprawić komfort użytkowania."
  + " Zakładamy, że nie masz nic przeciwko, ale możesz zrezygnować, jeśli chcesz."
  + "\nAkceptujęUstawienia prywatności\nPolityka prywatności\nClose";

/** mdk2.poznan.pl, 2026-08-20 — drzewo oferty zajęć; DOM widzi w nim listę kart */
const OFERTA = `* Oferta dla dzieci i młodzieży
 * Teatr [/oferta-zajec/teatr.html]
 * Do Góry [/oferta-zajec/teatr/dzieciecy-zespol-teatralny-do-gory.html]
 * Dzieciaki i ciotka Klotka [/oferta-zajec/teatr/wielkoludy-i-maludy.html]
 * Ekspresja [/oferta-zajec/teatr/ekspresja.html]
 * Taniec [/oferta-zajec/taniec.html]
 * Balet [/oferta-zajec/taniec/balet.html]
 * Muzyka [/oferta-zajec/muzyka.html]`;

/** puszczykowo.pl/wydarzenia, 2026-08-20 — pasek stron listingu */
const PAGER = `* ← Poprzedni
 * 1 (aktualna)
 * 2 [/wydarzenia?ccm_paging_p=2&ccm_order_by=ak_mevent_start_date asc, cName]
 * 3 [/wydarzenia?ccm_paging_p=3&ccm_order_by=ak_mevent_start_date asc, cName]
 * 4 [/wydarzenia?ccm_paging_p=4&ccm_order_by=ak_mevent_start_date asc, cName]
 * 5 [/wydarzenia?ccm_paging_p=5&ccm_order_by=ak_mevent_start_date asc, cName]`;

/** okpoznan.pl/wydarzenia, 2026-08-20 — pasek filtrów, ten od kolejności partnerów */
const FILTRY = `* Partnerzy
   Poznańskie Centrum Dziedzictwa: Brama Poznania, Centrum Szyfrów Enigma
   Biblioteka Raczyńskich, Muzeum Literackie Henryka Sienkiewicza
   Estrada Poznańska
   Centrum Kultury Zamek
 * Kategorie
   Benefity miejskie
   Edukacja
 * Wyczyść filtry [/wydarzenia]`;

describe("sito chromu — co musi zostać odsiane", () => {
  it("baner zgody na ciasteczka", () => {
    const v = looksLikeChrome(COOKIE);
    assert.equal(v.chrome, true, v.why);
    assert.match(v.why, /polityka prywatności|pliki cookie/u);
  });

  it("drzewo oferty zajęć — same odnośniki, ani jednej daty", () => {
    assert.equal(looksLikeChrome(OFERTA).chrome, true, looksLikeChrome(OFERTA).why);
  });

  it("pasek stron listingu", () => {
    assert.equal(looksLikeChrome(PAGER).chrome, true, looksLikeChrome(PAGER).why);
  });

  it("pasek filtrów — ten, którego kolejność zmienia się co dobę", () => {
    assert.equal(looksLikeChrome(FILTRY).chrome, true, looksLikeChrome(FILTRY).why);
  });

  it("notka mówi, CO zdecydowało — inaczej ślad nie tłumaczy odsiewu", () => {
    for (const t of [COOKIE, OFERTA, PAGER, FILTRY]) {
      const { why } = looksLikeChrome(t);
      assert.ok(why.length > 10 && !/^(true|chrome)/u.test(why), `bezużyteczna notka: ${why}`);
    }
  });
});

describe("sito chromu — czego odsiać nie wolno", () => {
  /**
   * bw.poznan.pl, 2026-08-20. TA zajawka złamała pierwszą wersję sita: „czytaj więcej" stało
   * w słowniku razem z „polityką prywatności", więc zdanie zakończone guzikiem wychodziło na
   * chrom — i cztery karty biblioteki z rzędu wypadały z ekstrakcji. Guzik jest chromem
   * WYŁĄCZNIE wtedy, gdy jest całym wierszem.
   */
  it("zajawka wydarzenia zakończona guzikiem „czytaj więcej” zostaje treścią", () => {
    const zajawka = "Wojewódzka Biblioteka Publiczna i Centrum Animacji Kultury w Poznaniu"
      + " oficjalnie zmienia nazwę. Już wkrótce nowa nazwa: Biblioteka Wielkopolska"
      + " im. Stanisława ...\nczytaj więcej"
      + "\n[https://bw.poznan.pl/biblioteka/aktualnosci/juz-wkrotce-nowa-nazwa/]";
    const v = looksLikeChrome(zajawka);
    assert.equal(v.chrome, false, `zajawka uznana za chrom: ${v.why}`);
  });

  /**
   * posir.poznan.pl, 2026-08-19. Sito szukało „rodo" przez `includes` i znajdowało je
   * w „mięDZYNaRODOwe Targi" — karta z dwoma wydarzeniami szła za stopkę prawną.
   */
  it("„międzynarodowe” nie jest „RODO”", () => {
    const karta = `niedziela, 04
cały dzień

25. POZNAŃ MARATON IM. MACIEJA FRANKIEWICZA [/wydarzenia/25-poznan-maraton]

Międzynarodowe Targi Poznańskie
ul. Głogowska 14 [/obiekty/mtp]`;
    assert.equal(looksLikeChrome(karta).chrome, false, looksLikeChrome(karta).why);
  });

  /**
   * WETO DATY jest bezwarunkowe i to jest cała ostrożność tego modułu: blok potrafi zawierać
   * naraz stopkę prawną i ogon karty (ok-lubon.pl, 2026-08-20), a wtedy żadne słownictwo
   * nie może przeważyć — patrz komentarz przy `looksLikeChrome`.
   */
  it("stopka prawna sklejona z kartą NIE jest chromem, bo niesie datę", () => {
    const sklejka = `14 marca 2026 12:00 - 13:00
[https://www.oklubon.pl/wydarzenia/spektakl-dla-dzieci-jajko]

POLITYKA PRYWATNOŚCI

Ta strona korzysta z ciasteczek aby świadczyć usługi na najwyższym poziomie, zgodnie z polityką prywatności [/rodo].`;
    const v = looksLikeChrome(sklejka);
    assert.equal(v.chrome, false, `sklejka z wydarzeniem uznana za chrom: ${v.why}`);
    assert.match(v.why, /data|godzina/u);
  });

  it("sama godzina wystarczy, żeby blok został treścią", () => {
    assert.equal(looksLikeChrome("Menu\nKontakt\nZajęcia 19:00").chrome, false);
  });

  /** gosir.dopiewo.pl, 2026-08-20 — numer telefonu w stopce nie jest datą i nie chroni chromu */
  it("numer telefonu w stopce nie udaje daty", () => {
    const stopka = `Przejdź do treści
 * 61-814-82-62
 * gosir@dopiewo.pl [gosir@dopiewo.pl]
 * BIP [https://gosir-dopiewo.bip.gov.pl/]
 * Mapa strony [/mapa-strony]`;
    assert.equal(looksLikeChrome(stopka).chrome, true, looksLikeChrome(stopka).why);
  });
});

describe("udział chromu w bloku", () => {
  it("liczy ZNAKI akapitów chromowych, nie ich sztuki", () => {
    const mieszany = [FILTRY, "Koncert Kwadrofonik, 12 sierpnia 2026, godz. 19:00."].join("\n\n");
    const share = chromeShare(paragraphs(mieszany));
    assert.ok(share > 0.8 && share < 1, `spodziewany przeważający chrom, było ${share}`);
    assert.equal(chromeShare(paragraphs(COOKIE)), 1);
    assert.equal(chromeShare(paragraphs("Koncert 12 sierpnia 2026")), 0);
  });
});

describe("podział paczki: co jedzie do modelu, a co odpada", () => {
  const chrom = toBlock(OFERTA, "content");
  const tresc = toBlock("KONCERT KWADROFONIK\n\n12 sierpnia 2026, godz. 19:00", "card");

  it("chromowy blok nie wchodzi do paczki, ale zostawia powód", () => {
    const { send, skipped } = partitionChrome([chrom, tresc]);
    assert.deepEqual(send.map((b) => b.hash), [tresc.hash]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.block.hash, chrom.hash);
    assert.ok(skipped[0]?.why.length);
  });

  /**
   * FAIL CLOSED. Strona, na której sito widzi sam chrom, to albo strona bez wydarzeń, albo
   * pomyłka sita — i tylko drugie jest groźne. Wysyłamy wtedy WSZYSTKO: koszt jednej strony
   * jest znany i mały, a cicho wygaszone źródło kosztuje wszystkie jego wydarzenia.
   */
  it("gdy CAŁA strona wyszła na chrom, nie odsiewamy niczego", () => {
    const { send, skipped } = partitionChrome([chrom, toBlock(PAGER, "content")]);
    assert.equal(send.length, 2, "cała strona uznana za chrom — paczka musi zostać nietknięta");
    assert.equal(skipped.length, 0);
  });
});
