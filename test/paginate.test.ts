/**
 * Adres NASTĘPNEJ STRONY listingu — odczytany ze strony, nie zgadnięty z nazwy parametru.
 *
 * Powód, dla którego to nie jest lista parametrów: pomiar 2026-08-20 na 35 źródłach nie-FB
 * dał siedem pagerów i pięć różnych konwencji naraz — `?pno=`, `?page=`, `/page/N/`,
 * `?ccm_paging_p=` i `<link rel="next">`. Dwie z nich (`pno`, `ccm_paging_p`) nie stoją
 * w `PAGE_PARAMS` w `shared/url-template.ts` i nigdy by tam nie trafiły, bo to nazwy
 * jednego CMS-a. Adres strony 2 stoi natomiast wprost w HTML-u każdej z nich.
 *
 * Fragmenty niżej są PRAWDZIWE, przycięte z żywych stron pobranych 2026-08-20 — razem
 * z tym, co w nich niewygodne: znacznikiem `<strong>` wokół numeru, spacją w query
 * i encją `&amp;`. Wymyślony pager dowodziłby wyłącznie tego, że wymyślony pager działa.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { nextPageUrl, worthReading } from "../src/pipeline/extract/paginate.js";

/** oklubon.pl/wydarzenia, 2026-08-20 — numer bieżącej strony NIE jest odnośnikiem */
const OK_LUBON = `<span class="em-pagination">
  <strong><span class="page-numbers current">1</span></strong>
  <a class="page-numbers" href="/wydarzenia?pno=2" title="2">2</a>
  <a class="page-numbers" href="/wydarzenia?pno=3" title="3">3</a>
</span>`;

/** mosina.pl/wydarzenia, 2026-08-20 — bootstrapowy `ul.pagination`, adresy bezwzględne */
const MOSINA = `<ul class="pagination">
  <li class="page-item disabled"><span class="page-link">&laquo;</span></li>
  <li class="page-item active"><span class="page-link">1</span></li>
  <li class="page-item"><a class="page-link" href="https://www.mosina.pl/wydarzenia?page=2">2</a></li>
  <li class="page-item"><a class="page-link" href="https://www.mosina.pl/wydarzenia?page=3">3</a></li>
</ul>`;

/** biblub.com, 2026-08-20 — wielokropek w środku pagera i osobny odnośnik „Następna" */
const BIBLUB = `<nav class="mo-pagination" role="navigation">
  <span aria-current="page" class="page-numbers current">1</span>
  <a class="page-numbers" href="https://biblub.com/page/2/">2</a>
  <a class="page-numbers" href="https://biblub.com/page/3/">3</a>
  <span class="page-numbers dots">&hellip;</span>
  <a class="page-numbers" href="https://biblub.com/page/5/">5</a>
  <a class="next page-numbers" href="https://biblub.com/page/2/">Następna &raquo;</a>
</nav>`;

/** puszczykowo.pl/wydarzenia, 2026-08-20 — SPACJA w query i `&amp;` w adresie */
const PUSZCZYKOWO = `<div class="ccm-pagination-wrapper"><ul class="pagination">
  <li class="prev disabled"><span>&larr; Poprzedni</span></li>
  <li class="active"><span>1 <span class="sr-only">(aktualna)</span></span></li>
  <li><a href="/wydarzenia?ccm_paging_p=2`
    + `&amp;ccm_order_by=ak_mevent_start_date asc, cName&amp;ccm_order_by_direction=asc">2</a></li>
  <li><a href="/wydarzenia?ccm_paging_p=3`
    + `&amp;ccm_order_by=ak_mevent_start_date asc, cName&amp;ccm_order_by_direction=asc">3</a></li>
</ul></div>`;

/** bracz.edu.pl/aktualnosci-kulturalne, 2026-08-20 — WordPress podaje następną stronę w <head> */
const BRACZ = `<head><link rel="canonical" href="https://bracz.edu.pl/aktualnosci-kulturalne/" />
  <link rel="next" href="https://bracz.edu.pl/aktualnosci-kulturalne/page/2/" /></head>
  <body><p>Lista aktualności bez widocznego pagera w tym wycinku.</p></body>`;

/**
 * okpoznan.pl/wydarzenia, 2026-08-20 — pager BEZ ani jednego adresu. Numer strony dokłada
 * JS w wywołaniu AJAX (`active_page` nie występuje w podanym HTML-u ani razu), więc pobraniem
 * `plain` nie da się tu dojść dalej niż do strony pierwszej. To ma zwrócić `null` i zostawić
 * ślad, a nie zgadywać adres.
 */
const OKPOZNAN = `<div class="paggination_box"><div class="numbers"><ul>
  <li class="active"><a class="js_ajax_box_page_link">1</a></li>
  <li><a class="js_ajax_box_page_link">2</a></li>
  <li><a class="js_ajax_box_page_link">3</a></li>
</ul></div><div class="btn_sites next"><a class="js_ajax_box_page_next_link">Następna strona</a></div></div>`;

/**
 * poznan.pl/mim/events, 2026-08-20 — KALENDARZ, nie pager, i to jest tu pułapka.
 * Komórki niosą numery dni w tym samym kształcie, co numery stron („1", „2"), a adres
 * prowadzi do innego DNIA, nie do dalszej części tej samej listy. Pójście za tym otwiera
 * trzydzieści stron zamiast jednej.
 */
const POZNAN_KALENDARZ = `<table><tr>
  <td></td><td></td><td></td><td></td><td></td>
  <td><a href="/mim/events/2026-08-01/">1</a></td>
  <td><a href="/mim/events/2026-08-02/">2</a></td>
</tr><tr>
  <td><a href="/mim/events/2026-08-03/">3</a></td>
  <td><a href="/mim/events/2026-08-04/">4</a></td>
</tr></table>`;

/**
 * gazeta-lubon.pl/2026/losir-kalendarium, 2026-08-20 — `rel="next"` na `<a>`, i to jest
 * PUŁAPKA: WordPress podpisuje tak nawigację między WPISAMI, nie strony archiwum. Pójście
 * za tym wyprowadza z listingu w losowy artykuł („XXI sesja Rady Miasta Luboń") i dalej,
 * bez końca. `<link rel="next">` w nagłówku znaczy co innego — to zdanie o TYM zasobie
 * i jego dalszej części, i tylko jemu ufamy.
 */
const GAZETA_LUBON = `<head><title>LOSiR kalendarium</title></head><body>
  <article><h1>LOSiR kalendarium</h1><p>Treść wpisu.</p></article>
  <nav class="post-navigation">
    <a href="https://www.gazeta-lubon.pl/2026/xxi-sesja-rady-miasta-lubon/" rel="next">
      Następny wpis</a>
  </nav></body>`;

describe("adres następnej strony", () => {
  it("czyta parametr, którego nie ma w żadnej naszej liście nazw", () => {
    assert.equal(nextPageUrl(OK_LUBON, "https://www.oklubon.pl/wydarzenia", 1),
      "https://www.oklubon.pl/wydarzenia?pno=2");
  });

  it("radzi sobie z adresem bezwzględnym w pagerze", () => {
    assert.equal(nextPageUrl(MOSINA, "https://www.mosina.pl/wydarzenia", 1),
      "https://www.mosina.pl/wydarzenia?page=2");
  });

  it("bierze numer, nie „Następną” — wielokropek w pagerze nie przestawia liczenia", () => {
    assert.equal(nextPageUrl(BIBLUB, "https://biblub.com/", 1), "https://biblub.com/page/2/");
  });

  it("nie wywraca się na spacji i encji w query", () => {
    const got = nextPageUrl(PUSZCZYKOWO, "https://puszczykowo.pl/wydarzenia", 1);
    assert.ok(got?.includes("ccm_paging_p=2"), `dostaliśmy ${got}`);
    assert.ok(!got?.includes("&amp;"), "encja została w adresie");
  });

  it("bierze <link rel=next>, gdy pagera nie widać", () => {
    assert.equal(nextPageUrl(BRACZ, "https://bracz.edu.pl/aktualnosci-kulturalne/", 1),
      "https://bracz.edu.pl/aktualnosci-kulturalne/page/2/");
  });

  it("ze strony 2 prowadzi na 3, a nie z powrotem na 2", () => {
    assert.equal(nextPageUrl(MOSINA, "https://www.mosina.pl/wydarzenia?page=2", 2),
      "https://www.mosina.pl/wydarzenia?page=3");
  });

  it("pager bez adresów to koniec drogi, nie adres zgadnięty", () => {
    assert.equal(nextPageUrl(OKPOZNAN, "https://okpoznan.pl/wydarzenia", 1), null);
  });

  it("kalendarz dni NIE jest pagerem", () => {
    assert.equal(nextPageUrl(POZNAN_KALENDARZ, "https://www.poznan.pl/mim/events/", 1), null);
  });

  it("„następny WPIS” to nie następna strona listingu", () => {
    assert.equal(nextPageUrl(GAZETA_LUBON, "https://www.gazeta-lubon.pl/2026/losir-kalendarium/", 1),
      null);
  });

  it("strona bez pagera nie udaje, że ma dalszy ciąg", () => {
    assert.equal(nextPageUrl("<main><h1>Wydarzenia</h1><p>Nic więcej.</p></main>",
      "https://x.pl/wydarzenia", 1), null);
  });
});

/**
 * DARMOWA SONDA PRZED PŁATNYM WYWOŁANIEM.
 *
 * Kolejna strona listingu bywa warta pieniędzy, a bywa archiwum — i rozstrzyga o tym
 * PORZĄDEK SORTOWANIA serwisu, nie jego adres. Pomiar 2026-08-20 na żywych stronach 2:
 *
 *   mosina.pl/wydarzenia?page=2       3 daty, 2 przyszłe (kalendarz rosnąco)  → czytać
 *   puszczykowo ?ccm_paging_p=2       6 dat, 6 przyszłych                     → czytać
 *   poznan.pl/mim/events/2/          22 daty, 21 przyszłych                   → czytać
 *   biblub.com/page/2/                9 dat, ZERO przyszłych (2024-06…2026-05) → pominąć
 *   oklubon ?pno=2, bracz .../page/2/ zero dat w treści                       → czytać
 *
 * Pobranie HTTP jest darmowe, więc sonda liczy daty w gotowym tekście i dopiero potem
 * decyduje o wywołaniu modelu. Przy braku dat czytamy MIMO WSZYSTKO: asymetria jest
 * jednostronna — pominięta strona kosztuje cały swój listing (23 nowe wpisy na oklubon),
 * a niepotrzebne wywołanie kosztuje ~$0,0015.
 */
describe("czy następną stronę warto czytać", () => {
  /** biblub.com/page/2, 2026-08-20 — blog biblioteki, sortowanie od najnowszego wpisu */
  const BIBLUB_S2 = `Aktualności\n[https://biblub.com/wp-content/uploads/2026/05/P1080595-300x225.jpg]\n\n`
    + `22.05.2026\n\n\nSPEKTAKL „CO JEST GRANE?”\n\nSpektakl w wykonaniu grupy teatralnej COKOLWIEK…\n\n`
    + `[https://biblub.com/aktualnosci/spektakl-co-jest-grane/]\n\n17.04.2026\n\n\nCZYTASIA – PROJEKT DLA Z`;

  /** mosina.pl/wydarzenia?page=2, 2026-08-20 — kalendarz wydarzeń, sortowanie rosnąco */
  const MOSINA_S2 = `poniedziałek, 24 sierpnia - poniedziałek, 24 sierpnia\n\n`
    + `ZEBRANIE WIEJSKIE SOŁECTWA BORKOWICE, BOLESŁAWIEC\n\nW DNIU 24.08.2026 R., O GODZ. 18:00, `
    + `W ŚWIETLICY WIEJSKIEJ W BORKOWICACH, ODBĘDZIE SIĘ ZEBRANIE WIEJSKIE\n\n`
    + `Czytaj więcej [/wydarzenia/zebranie-wiejskie-solectwa-borkowice-boleslawiec-5]`;

  it("strona z samą przeszłością nie idzie do modelu", () => {
    const v = worthReading(BIBLUB_S2, "2026-08-20");
    assert.equal(v.read, false);
    assert.match(v.why, /przyszł/u, `notka nie tłumaczy decyzji: „${v.why}"`);
  });

  it("strona z przyszłym terminem idzie", () => {
    assert.equal(worthReading(MOSINA_S2, "2026-08-20").read, true);
  });

  it("brak dat w treści czytamy MIMO WSZYSTKO — fail open", () => {
    const v = worthReading("Aktualności\n\nSpektakl dla dzieci „Jajko”\n\nWięcej [/wydarzenia/jajko]", "2026-08-20");
    assert.equal(v.read, true);
    assert.match(v.why, /bez dat|nie ma dat/u, `notka nie tłumaczy decyzji: „${v.why}"`);
  });

  it("data w adresie nie jest terminem — permalink nie ratuje archiwum", () => {
    // /2026/09/ w adresie to katalog publikacji; gdyby liczyła się jak termin, archiwum
    // z 2026-05 wyglądałoby na stronę z przyszłością i płacilibyśmy za nie co dzień
    const v = worthReading(`[https://biblub.com/wp-content/uploads/2026/09/foto.jpg]\n\n22.05.2026\n\nWPIS`,
      "2026-08-20");
    assert.equal(v.read, false);
  });

  it("polski miesiąc słownie liczy się jak data", () => {
    assert.equal(worthReading("Koncert 14 marca 2026, godz. 12:00", "2026-08-20").read, false);
    assert.equal(worthReading("Koncert 14 września 2026, godz. 12:00", "2026-08-20").read, true);
  });
});
