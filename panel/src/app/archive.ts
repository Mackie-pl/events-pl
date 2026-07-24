import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, of } from 'rxjs';

/**
 * Dostęp do prywatnego archiwum przez lokalny most (`npm run archive-server`).
 *
 * Panel jest publiczną stroną statyczną, więc NIE MOŻE trzymać klucza `service_role` —
 * klucz zostaje w procesie node'owym na localhoście. Gdy most nie odpowiada (czyli zawsze
 * na wdrożonym panelu), sekcja archiwum po prostu się nie pokazuje.
 */
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const BASE_KEY = 'events-pl-panel:archive-base';

@Injectable({ providedIn: 'root' })
export class ArchiveService {
  private readonly http = inject(HttpClient);

  /** Nadpisywalne w localStorage, gdyby port 8787 był zajęty. */
  readonly base = localStorage.getItem(BASE_KEY) ?? DEFAULT_BASE;

  /** null = jeszcze nie sprawdzono, false = brak mostu (panel wdrożony). */
  readonly available = signal<boolean | null>(null);

  constructor() {
    this.probe();
  }

  probe(): void {
    this.http
      .get<{ ok?: boolean }>(`${this.base}/health`)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => this.available.set(r?.ok === true));
  }

  /** Treść obiektu archiwum jako sformatowany JSON; komunikat błędu zamiast wyjątku. */
  object(path: string) {
    return this.http.get(`${this.base}/object`, { params: { path }, responseType: 'text' }).pipe(
      map((text) => {
        try {
          return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          return text;
        }
      }),
      catchError((e: unknown) =>
        of(`Nie udało się pobrać ${path}\n\n${e instanceof Error ? e.message : String(e)}`),
      ),
    );
  }
}
