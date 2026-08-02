/**
 * Ratowanie kompletnych rekordów z uciętej odpowiedzi modelu.
 *
 * Model wypisujący długą tablicę i przerwany na `max_tokens` zostawia dokument, w którym
 * ostatni obiekt nie ma domknięcia. `JSON.parse` na taki dokument rzuca, a rzucając kasuje
 * TAKŻE wszystkie kompletne obiekty przed miejscem ucięcia — dokładnie to zdarzyło się
 * Poznaniowi 2026-08-01: kilkadziesiąt poprawnych propozycji poszło do kosza razem
 * z jedną niedokończoną, po opłaconym wywołaniu za $0.09.
 *
 * Skaner nie jest parserem JSON-a i nie próbuje nim być: liczy nawiasy klamrowe poza
 * literałami tekstowymi, a rozstrzyganie poprawności zostawia `JSON.parse` na wyciętym
 * fragmencie. Obiekt, który się nie parsuje, po prostu wypada — z założenia „lepiej mniej
 * i pewnych" niż zgadywanie brakującego ogona.
 */

/**
 * Kompletne obiekty najwyższego poziomu z tablicy pod kluczem `key`.
 * Zwraca pustą listę, gdy tablicy nie ma albo nic się w niej nie domyka.
 */
export function salvageArray(text: string, key: string): unknown[] {
  const at = text.indexOf(`"${key}"`);
  const start = text.indexOf("[", at < 0 ? 0 : at);
  if (start < 0) return [];

  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;

  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      // kolejność ma znaczenie: `\\` przed `"`, inaczej `\"` zamknęłoby literał
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {
          // niekompletny albo zepsuty rekord — świadomie pomijamy, reszta tablicy zostaje
        }
        objStart = -1;
      }
    } else if (c === "]" && depth === 0) {
      break; // tablica domknięta — dalej jest już inne pole dokumentu
    }
  }
  return out;
}
