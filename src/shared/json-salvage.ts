/**
 * Ratowanie kompletnych rekordów z uszkodzonej odpowiedzi modelu.
 *
 * Prowadzą tu dwie różne awarie:
 *
 *   1. UCIĘCIE na `max_tokens` — ostatni obiekt nie ma domknięcia. `JSON.parse` na taki
 *      dokument rzuca, a rzucając kasuje TAKŻE wszystkie kompletne obiekty przed miejscem
 *      ucięcia: Poznań 2026-08-01, kilkadziesiąt poprawnych propozycji do kosza po opłaconym
 *      wywołaniu za $0.09.
 *
 *   2. ZEPSUTY LITERAŁ w środku tablicy — najczęściej polski cudzysłów otwierający domknięty
 *      ASCII-owym (`„Wydarzenia w Luboniu"`), czyli string JSON-a urwany w połowie wartości.
 *
 * Druga jest groźniejsza, bo nie ogranicza się do ogona. Jeden nadmiarowy `"` odwraca
 * PARZYSTOŚĆ cudzysłowów do końca dokumentu: skaner od tego miejsca bierze strukturę za tekst,
 * przestaje liczyć prawdziwe klamry i nie domyka już żadnego obiektu. Luboń 2026-08-02: model
 * zaproponował 17 źródeł, literał pękł w 15., a przepadły wszystkie trzy grupy FB — mimo że
 * rekordy 16. i 17. były poprawnym JSON-em. Grupy są jedynymi źródłami FB, które daily pobiera
 * (fanpage'e pomija), więc jeden znak kosztował całą kategorię.
 *
 * Stąd resynchronizacja. Kotwicą jest `{` NA POCZĄTKU WIERSZA — jedyny punkt, którego
 * rozpoznanie nie zależy od stanu skanera, a więc jedyny, na którym da się odzyskać
 * synchronizację po zepsutym rekordzie. Po nieudanym rekordzie wracamy na najbliższą kotwicę
 * z wyzerowanym stanem i czytamy dalej. Dokument w jednym wierszu kotwic nie ma i zachowuje
 * się jak dotąd — konserwatywnie.
 *
 * Skaner nie jest parserem JSON-a i nie próbuje nim być: liczy nawiasy klamrowe poza
 * literałami tekstowymi, a rozstrzyganie poprawności zostawia `JSON.parse` na wyciętym
 * fragmencie. Obiekt, który się nie parsuje, po prostu wypada — z założenia „lepiej mniej
 * i pewnych" niż zgadywanie brakującego ogona.
 */

/** Indeks `}` domykającego obiekt spod `from`, albo -1, gdy obiekt się nie domyka. */
function findClose(text: string, from: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      // kolejność ma znaczenie: `\\` przed `"`, inaczej `\"` zamknęłoby literał
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Najbliższy `{` rozpoczynający wiersz, czyli miejsce, od którego wolno czytać od nowa.
 * Regexp jest lokalny, bo `lastIndex` to stan — moduł współdzielący go między wywołaniami
 * gubiłby rekordy zależnie od kolejności wywołań.
 */
function nextRecordAnchor(text: string, from: number): number {
  const anchor = /\n[ \t]*\{/g;
  anchor.lastIndex = from;
  const m = anchor.exec(text);
  return m ? m.index + m[0].length - 1 : -1;
}

/**
 * Kompletne obiekty najwyższego poziomu z tablicy pod kluczem `key`.
 * Zwraca pustą listę, gdy tablicy nie ma albo nic się w niej nie domyka.
 */
export function salvageArray(text: string, key: string): unknown[] {
  const at = text.indexOf(`"${key}"`);
  const start = text.indexOf("[", at < 0 ? 0 : at);
  if (start < 0) return [];

  const out: unknown[] = [];
  let i = start + 1;

  while (i < text.length) {
    const objStart = text.indexOf("{", i);
    if (objStart < 0) break;
    // `]` przed kolejnym obiektem = koniec NASZEJ tablicy, dalej są inne pola dokumentu.
    // Między rekordami stoją tylko białe znaki i przecinek, więc szukanie napisem wystarczy.
    if (text.slice(i, objStart).includes("]")) break;

    const close = findClose(text, objStart);
    if (close >= 0) {
      try {
        out.push(JSON.parse(text.slice(objStart, close + 1)));
        i = close + 1;
        continue;
      } catch { /* rekord zepsuty — resync niżej */ }
    }

    // Rekord się nie domknął albo nie sparsował: stan skanera przestał być wiarygodny
    // i dalsze liczenie klamer od tego miejsca nic już nie znaczy.
    const anchor = nextRecordAnchor(text, objStart + 1);
    if (anchor >= 0) { i = anchor; continue; }
    if (close >= 0) { i = close + 1; continue; } // jeden wiersz: nie ma na co resynchronizować
    break;
  }
  return out;
}
