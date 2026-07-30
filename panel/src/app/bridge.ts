import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

import type { ProbeResult } from './types';

/**
 * Lokalny most panelu (`npm run panel-server`) — jedyna droga do rzeczy, których statyczna
 * strona zrobić nie może:
 *
 *   - czytanie prywatnego archiwum (klucz sekretny zostaje w procesie node'owym),
 *   - sprawdzenie źródła na żądanie (pobranie + PŁATNE wywołanie modelu).
 *
 * Wdrożony panel (GH Pages) odpytuje 127.0.0.1, nie dostaje odpowiedzi i chowa oba przyciski.
 * Nie jest to obejście zabezpieczenia, tylko jego konsekwencja: gdyby panel umiał to sam,
 * umiałby to każdy odwiedzający.
 */
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const BASE_KEY = 'events-pl-panel:archive-base';

interface Health {
  ok?: boolean;
  /** Most stoi, ale bez SUPABASE_* — sonda działa, archiwum nie. */
  archive?: boolean;
  /** Most umie oddać pliki danych z drzewa roboczego (`/file?name=…`). */
  files?: boolean;
}

@Injectable({ providedIn: 'root' })
export class BridgeService {
  private readonly http = inject(HttpClient);

  /** Nadpisywalne w localStorage, gdyby port 8787 był zajęty. */
  readonly base = localStorage.getItem(BASE_KEY) ?? DEFAULT_BASE;

  /** null = jeszcze nie sprawdzono, false = brak mostu (panel wdrożony). */
  readonly available = signal<boolean | null>(null);

  /** Most bez konfiguracji Supabase: sonda tak, podgląd archiwum nie. */
  readonly archiveReadable = signal(false);

  /**
   * Most oddaje pliki danych z drzewa roboczego. Rozstrzyga, CZY panel patrzy na stan
   * lokalny, czy na opublikowany — patrz `DataService.fileBase`. Osobno od `available`,
   * bo starszy most (sprzed tej funkcji) odpowiada na /health bez pola `files`.
   */
  readonly servesFiles = signal(false);

  constructor() {
    this.checkHealth();
  }

  checkHealth(): void {
    this.http
      .get<Health>(`${this.base}/health`)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => {
        this.available.set(r?.ok === true);
        this.archiveReadable.set(r?.archive === true);
        this.servesFiles.set(r?.ok === true && r.files === true);
      });
  }

  /** Treść obiektu archiwum jako sformatowany JSON; komunikat błędu zamiast wyjątku. */
  object(path: string): Observable<string> {
    return this.http.get(`${this.base}/object`, { params: { path }, responseType: 'text' }).pipe(
      map((text) => {
        try {
          return JSON.stringify(JSON.parse(text) as unknown, null, 2);
        } catch {
          return text;
        }
      }),
      catchError((e: unknown) => of(`Nie udało się pobrać ${path}\n\n${message(e)}`)),
    );
  }

  /**
   * Sprawdź jedno źródło TERAZ. `force` pomija cache, czyli gwarantuje pobranie i wywołanie
   * modelu — bez tego niezmieniona strona wraca z cache w 200 ms i niczego nie sprawdza.
   *
   * Bez timeoutu celowo: pobranie + model + followupy potrafią zająć minutę, a przerwanie
   * w połowie i tak nie zatrzyma pracy po stronie mostu — zgubiłoby tylko wynik, za który
   * już zapłacono.
   */
  probe(sourceId: string, force: boolean): Observable<ProbeResult | { error: string }> {
    const params = { source: sourceId, ...(force ? { force: '1' } : {}) };
    return this.http.post<ProbeResult>(`${this.base}/probe`, null, { params }).pipe(
      catchError((e: unknown) => of({ error: message(e) })),
    );
  }
}

/** Most odsyła `{error}` z sensowną treścią — pokazujemy ją zamiast „Http failure response". */
function message(e: unknown): string {
  const body: unknown = (e as { error?: unknown }).error;
  if (typeof body === 'object' && body !== null && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
