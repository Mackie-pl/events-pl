import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiIcon, TuiLink, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';

import { DataService } from '../../data';
import { STATUS_META, fmtDateTime } from '../../format';

import { type EventHit, type Sighting, buildIndex, search } from './event-index';

/**
 * Tyle wyników rysujemy. Wyszukiwanie po nazwie służy DOJŚCIU do jednego wydarzenia, więc
 * dwieście wierszy to już sygnał „doprecyzuj zapytanie", a nie materiał do przewijania.
 */
const LIMIT = 200;

/**
 * „Skąd się wzięło to wydarzenie?" — wejście do śladu decyzyjnego od strony NAZWY.
 *
 * Panel dawał dotąd wejść wyłącznie od przebiegu i źródła: żeby zobaczyć, czemu coś wygląda
 * tak, jak wygląda, trzeba było najpierw wiedzieć, KTO to znalazł i KIEDY — czyli znać
 * odpowiedź przed zadaniem pytania. Skorowidz liczy się z `runs.json` (pole `produced`),
 * więc pokazuje też rekordy, które PRZEGRAŁY dedupe i do events.json nigdy nie doszły.
 */
@Component({
  selector: 'app-event-search',
  imports: [RouterLink, TuiIcon, TuiLink, TuiLoader, TuiTitle, TuiBadge],
  templateUrl: './event-search.html',
  styleUrl: './event-search.less',
})
export class EventSearchPage {
  /** Zapytanie w adresie — wynik wyszukiwania da się wkleić w zgłoszeniu i w rozmowie. */
  readonly q = signal<string>('');

  protected readonly data = inject(DataService);
  private readonly router = inject(Router);

  protected readonly dt = fmtDateTime;
  protected readonly statusMeta = STATUS_META;
  protected readonly limit = LIMIT;

  protected readonly query = linkedSignal(() => this.q());
  protected readonly opened = signal<string | null>(null);

  private readonly index = computed(() =>
    buildIndex(this.data.runs.value(), this.data.events.value().events),
  );

  protected readonly results = computed(() => search(this.index(), this.query()));

  protected readonly shown = computed(() => this.results().slice(0, LIMIT));

  /**
   * Ile wydarzeń w ogóle da się przeszukać i z ilu przebiegów. Bez tej liczby „brak wyników"
   * jest dwuznaczne: albo takiego wydarzenia nie było, albo skorowidz jest pusty, bo
   * przebiegi w historii są sprzed pola `produced` — a to dwie zupełnie różne odpowiedzi.
   */
  protected readonly scope = computed(() => {
    const runs = this.data.runs.value();
    const withRefs = runs.filter((r) => r.sources.some((s) => s.produced !== undefined));
    return { events: this.index().length, runs: runs.length, withRefs: withRefs.length };
  });

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    console.log('onInput', value);
    this.query.set(value);
    // `replaceUrl`, bo inaczej każda litera zostawia wpis w historii przeglądarki i „wstecz"
    // przestaje wracać tam, skąd się przyszło.
    void this.router.navigate([], {
      queryParams: { q: value || null },
      replaceUrl: true,
    });
  }

  protected toggle(key: string): void {
    this.opened.update((cur) => (cur === key ? null : key));
  }

  /** Wystąpienie, w którym wydarzenie POWSTAŁO — najstarszy zachowany ślad. */
  protected first(hit: EventHit): Sighting | undefined {
    return hit.sightings[0];
  }

  /** Ile RÓŻNYCH źródeł je zgłosiło — więcej niż jedno znaczy, że po drodze było scalanie. */
  protected sources(hit: EventHit): number {
    return new Set(hit.sightings.map((s) => s.sourceId)).size;
  }

  /** Czy przebieg jest jeszcze w runs.json — bez tego link prowadziłby w pustą stronę. */
  protected runExists(startedAt: string): boolean {
    return !!this.data.runByStartedAt(startedAt);
  }
}
