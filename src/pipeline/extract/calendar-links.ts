/**
 * Widget „dodaj do kalendarza" w treści strony: zostawiamy go, odbieramy mu tylko kłamstwo.
 *
 * Link `calendar/render?action=TEMPLATE` to DANE STRUKTURALNE — tytuł, `location`, początek,
 * koniec, strefa — więc jest lepszym źródłem niż proza obok i wycinanie go z treści byłoby
 * stratą. Format (nieudokumentowany oficjalnie przez Google, ale zgodnie opisany przez
 * `add-event-to-calendar-docs` i pochodne): `dates=YYYYMMDD/YYYYMMDD` dla wpisu całodniowego,
 * `YYYYMMDDTHHMMSS` dla wpisu z godziną.
 *
 * Problem jest w CMS-ach, które wpis całodniowy zapisują w formie Z GODZINĄ, wstawiając tam
 * moment wygenerowania rekordu. Model czyta URL i wierzy — a w digeście pojawia się godzina,
 * której nikt nigdy nie opublikował. Zmierzone na `posir.poznan.pl/wydarzenia` (2026-08-12):
 * cztery takie wpisy trafiły do events.json z godzinami 11:46, 15:18, 15:21 i 15:25, przy
 * pustej kolumnie godziny w widocznej tabeli.
 *
 * SYGNATURA, po której je poznajemy: godzina początku RÓWNA godzinie końca. To nie jest
 * przedział czasu — przedział o zerowej długości nie znaczy nic. Pomiar na tej samej stronie
 * (41 linków): 20 par z prawdziwym przedziałem (19:00–21:15, 17:00–20:00, 20:00–22:30…),
 * 14 w poprawnej formie całodniowej, 4 z tą sygnaturą. Reguła łapie 4/4 i nie rusza 0/20.
 *
 * Reguła MYLI SIĘ BEZPIECZNIE i to jest jej główne uzasadnienie: gdyby kiedyś trafiła na
 * wydarzenie naprawdę zapisane z zerowym czasem trwania, skutkiem jest wpis BEZ godziny —
 * czyli stan, w którym jest już 78 innych wydarzeń. Stan dzisiejszy to zamiast tego godzina
 * fałszywa, a fałszu z danych nikt potem nie wyprostuje.
 *
 * Zasięg zmierzony przed napisaniem tego pliku: z 33 pobieranych źródeł (plain/headless,
 * spoza FB, wszystkie pobrały się bez błędu) widget Google ma DOKŁADNIE JEDNO — `posir-poznan`.
 * Odpowiedników Outlooka i Yahoo nie ma nigdzie. Funkcja jest więc ogólna, ale dziś pracuje
 * nad jednym serwisem; nic innego nie ma jak na niej stracić.
 */

/** Cały adres widgetu — do granicy cudzysłowu/białego znaku, czyli tak, jak stoi w HTML-u. */
const WIDGET = /calendar\/render\?action=TEMPLATE[^\s"'<>]*/gi;

/**
 * Para `dates=` w formie z godziną. Separator bywa zakodowany (`%2F`) albo nie — POSIR
 * używa pierwszej postaci, generatory linków bywają różne, a pomyłka tutaj to cichy brak
 * poprawki, nie błąd.
 */
const TIMED_PAIR = /(dates=)(\d{8})T(\d{6})(%2F|\/)(\d{8})T(\d{6})/i;

/**
 * Zdejmuje część godzinową z par `dates=`, w których początek i koniec mają IDENTYCZNĄ
 * godzinę. Zwraca też licznik — bez niego poprawka byłaby jedyną decyzją w tym potoku
 * niezostawiającą śladu (patrz wywołanie w process-source.ts).
 *
 * Daty zostają takie, jakie były: specyfikacja chce dla całodniowych końca o dzień PÓŹNIEJ
 * (koniec wyłączny), ale konsumentem tego tekstu jest model czytający go RAZEM z widocznym
 * wierszem („17.10 – 18.10"). Dosunięcie końca o dzień rozjechałoby URL z tym wierszem
 * i zachęcało do wymyślenia dnia, którego nie ma. Poprawność wobec Kalendarza Google nie jest
 * tu celem — celem jest nie podawać modelowi godziny, której nikt nie opublikował.
 */
export function fixCalendarDates(text: string): { text: string; fixed: number } {
  let fixed = 0;
  const out = text.replace(WIDGET, (url) => {
    const m = TIMED_PAIR.exec(url);
    if (!m || m[3] !== m[6]) return url;
    fixed += 1;
    return url.replace(TIMED_PAIR, `$1$2$4$5`);
  });
  return { text: out, fixed };
}
