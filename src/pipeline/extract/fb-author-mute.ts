/**
 * Wyciszanie AUTORA, którego plakaty raz po raz nie niosą wydarzenia.
 *
 * Po co, skoro jest już `posterKey`: tamten cache rozpoznaje ten sam PLIK, a sprzedawca
 * borówek wrzuca co kilka dni inne zdjęcie — nowy zasób, nowy klucz, nowy płatny odczyt.
 * Zmierzone 2026-08-20: pole `user_url` jest w każdej grupie, a powtarzalność realna
 * (99 autorów na 123 posty, 14 pisało więcej niż raz). Tego samego dnia sufit odczytów
 * skończył się na grupie, która dała 5 z 8 wydarzeń — czyli szum nie kosztuje $0.001,
 * tylko MIEJSCE w puli, a miejsce jest tu zasobem rzadkim.
 *
 * PII: klucz to `sha256(sól + id autora)`, samo id nigdzie nie ląduje. Repo jest publiczne,
 * `state.json` commitowany, a autor postu w wiejskiej grupie to osoba prywatna. Bez
 * `FB_AUTHOR_SALT` mechanizm w ogóle nie rusza — ta sama reguła co przy wyciszaniu źródeł:
 * sito kasujące cudze wydarzenia nie może włączać się samo z domyślnej wartości.
 *
 * SAMOLECZENIE, bo inaczej to jest pułapka: wyciszenie wygasa po `FB_AUTHOR_MUTE_DAYS`
 * i wtedy licznik startuje od zera (pełna pula prób, nie jedna), a JEDNO wydarzenie kasuje
 * licznik natychmiast. Kto raz coś zorganizował, nie jest szumem — a rolnik od borówek
 * zimą potrafi ogłosić kolędowanie.
 *
 * Cena pomyłki jest tu z założenia niska: wyciszony autor DALEJ jedzie tekstem przez
 * normalną ekstrakcję. Tracimy wyłącznie odczyt obrazu.
 */
import { createHash } from "node:crypto";

import { P } from "../../config/params.js";
import { audit } from "../../shared/audit.js";
import { addDays, todayIso } from "../../shared/dates.js";
import type { PipelineState } from "../../types/index.js";

type Authors = NonNullable<PipelineState["fbPosterAuthors"]>;

const salt = (): string => P.FB_AUTHOR_SALT.get() ?? "";
const muteAfter = (): number => P.FB_AUTHOR_MUTE_AFTER.get();
const muteDays = (): number => P.FB_AUTHOR_MUTE_DAYS.get();

/** `null` = mechanizm wyłączony (brak soli) albo dataset nie oddał autora. */
export function authorKey(author: string | null): string | null {
  const s = salt();
  if (!s || !author) return null;
  return createHash("sha256").update(s).update(author).digest("hex").slice(0, 16);
}

/**
 * Czy pomijamy odczyt plakatu tego autora. Wygasłe wyciszenie kasujemy TU, przy pytaniu —
 * nie ma osobnego przebiegu sprzątającego, a stan, który sam nie wraca do gry, jest błędem.
 */
export function authorMuted(key: string | null, state: PipelineState): boolean {
  if (!key) return false;
  const rec = state.fbPosterAuthors?.[key];
  if (!rec?.mutedUntil) return false;
  if (rec.mutedUntil > todayIso()) return true;
  // wygasło: pełna pula prób od nowa, żeby jeden pusty plakat nie wyciszał natychmiast
  delete rec.mutedUntil;
  rec.empty = 0;
  audit("fb.group", "wyciszenie autora wygasło — jego plakaty wracają do odczytu", { author: key });
  return false;
}

/**
 * Wynik odczytu wraca do licznika autora. `events > 0` zeruje wszystko — to jest ta część,
 * przez którą mechanizm nie zamyka się na trwałe.
 */
export function noteAuthorRead(key: string | null, events: number, state: PipelineState): void {
  if (!key) return;
  const all: Authors = (state.fbPosterAuthors ??= {});
  const rec = (all[key] ??= { empty: 0, at: todayIso() });
  rec.at = todayIso();
  if (events > 0) {
    rec.empty = 0;
    delete rec.mutedUntil;
    return;
  }
  rec.empty += 1;
  if (rec.empty < muteAfter()) return;
  rec.mutedUntil = addDays(todayIso(), muteDays());
  audit("fb.group",
    `autor po ${rec.empty} plakatach bez wydarzenia — jego obrazy pomijamy do ${rec.mutedUntil} `
    + "(tekst postów czytamy dalej)",
    { author: key, empty: rec.empty, until: rec.mutedUntil });
}

/**
 * Wpisy autorów, którzy zniknęli z grup. Bez tego rejestr rośnie w commitowanym pliku
 * w nieskończoność, a wpis o kimś, kto nie napisał nic od pół roku, niczego już nie pilnuje.
 */
export function pruneAuthors(state: PipelineState, today: string): void {
  const all = state.fbPosterAuthors;
  if (!all) return;
  let dropped = 0;
  for (const [key, rec] of Object.entries(all)) {
    if (addDays(rec.at, 180) > today) continue;
    delete all[key];
    dropped += 1;
  }
  if (dropped) audit("fb.group", `${dropped} autorów wypadło z rejestru (cisza od 180 dni)`, { dropped });
}
