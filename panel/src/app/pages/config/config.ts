import { Component, computed, inject } from '@angular/core';
import { TuiButton, TuiIcon, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiTable } from '@taiga-ui/addon-table';

import { DataService } from '../../data';
import { fmtDateTime } from '../../format';
import type { ConfigMetaParam, ConfigValue, ParamClass } from '../../types';

/**
 * Konfiguracja potoku — READ-ONLY, i to nie jest brak funkcji, tylko konsekwencja.
 *
 * Progi mieszkają w commitowanym `config.json` po to, żeby ich zmiana miała datę, autora
 * i diff. Panel, który by je zapisywał bez commita, oddawałby dokładnie tę własność, dla
 * której plik powstał — więc dopóki nie ma czego wołać po stronie serwera („zapisz i zacommituj"),
 * ekran pokazuje, a nie zmienia.
 *
 * CZEGO TU NIE ZOBACZYSZ i dlaczego: wartości sekretów oraz nadpisań ze zmiennych środowiskowych.
 * Panel czyta wyłącznie pliki repo, a te są publiczne — klucza nie ma tu z czego wziąć. Nadpisania
 * env są niewidoczne z tego samego powodu, ale nie znikają bez śladu: każdy przebieg zapisuje
 * w raporcie listę progów, które tamtej nocy przyszły ze środowiska, i to widać w sekcji na górze.
 */
type Origin = 'config.json' | 'domyślna' | 'środowisko' | 'runner';

interface Row {
  name: string;
  cls: ParamClass;
  summary: string;
  def: ConfigValue;
  /** `null` znaczy „panel nie ma prawa/skąd tego znać", a nie „nie ustawiono" */
  value: ConfigValue;
  origin: Origin;
  /** wartość odbiega od domyślnej — czyli ktoś świadomie ją ruszył */
  tuned: boolean;
}

interface Group {
  id: string;
  title: string;
  rows: Row[];
}

/** Jedna zmiana progu między migawką z przebiegu a tym, co stoi w pliku teraz. */
interface Drift {
  name: string;
  then: ConfigValue;
  now: ConfigValue;
}

const CLASS_LABEL: Record<ParamClass, string> = {
  tuning: 'próg',
  secret: 'sekret',
  setting: 'ustawienie',
  endpoint: 'adres',
  ambient: 'środowisko',
};

/**
 * Plakietka klasy. Wyróżnione są dwie: progi (jedyne, które da się tu zmienić — przez plik)
 * i sekrety (jedyne, których wartości panel nigdy nie pokaże). Reszta to tło.
 */
const CLASS_BADGE: Record<ParamClass, string> = {
  tuning: 'info',
  secret: 'warning',
  setting: 'neutral',
  endpoint: 'neutral',
  ambient: 'neutral',
};

@Component({
  selector: 'app-config',
  imports: [TuiButton, TuiIcon, TuiLoader, TuiTitle, TuiBadge, TuiTable],
  templateUrl: './config.html',
  styleUrl: './config.less',
})
export class ConfigPage {
  protected readonly data = inject(DataService);
  protected readonly dt = fmtDateTime;
  protected readonly classLabel = CLASS_LABEL;
  protected readonly classBadge = CLASS_BADGE;

  /** Wartości progów bez klucza `_` — to notka dla kogoś, kto otworzy plik, nie parametr. */
  private readonly values = computed<Record<string, ConfigValue>>(() => {
    const raw = this.data.configValues.value();
    if (!raw) return {};
    const out: Record<string, ConfigValue> = {};
    for (const [k, v] of Object.entries(raw)) if (k !== '_') out[k] = v;
    return out;
  });

  private row(p: ConfigMetaParam, values: Record<string, ConfigValue>): Row {
    // Tylko progi da się odczytać z repo. Reszta żyje w środowisku i panel zgaduje najwyżej
    // wartość domyślną — mówi to wprost, zamiast pokazywać liczbę, która może być nieprawdą.
    if (p.cls === 'tuning') {
      const inFile = p.name in values && values[p.name] !== null;
      const value = inFile ? values[p.name] : p.def;
      return {
        ...p,
        value,
        origin: inFile ? 'config.json' : 'domyślna',
        tuned: value !== p.def,
      };
    }
    const origin: Origin = p.cls === 'ambient' ? 'runner' : 'środowisko';
    return { ...p, value: p.cls === 'secret' ? null : p.def, origin, tuned: false };
  }

  protected readonly groups = computed<Group[]>(() => {
    const meta = this.data.configMeta.value();
    if (!meta) return [];
    const values = this.values();
    return meta.groups
      .map((g) => ({
        id: g.id,
        title: g.title,
        rows: meta.params.filter((p) => p.group === g.id).map((p) => this.row(p, values)),
      }))
      .filter((g) => g.rows.length > 0);
  });

  protected readonly tunedCount = computed(
    () => this.groups().reduce((n, g) => n + g.rows.filter((r) => r.tuned).length, 0),
  );

  /** Ostatni przebieg — nośnik migawki progów, którymi się kierował. */
  private readonly lastRun = computed(() => this.data.runsDesc()[0]);

  /**
   * Czym różni się dzisiejszy plik od tego, czym kierował się ostatni przebieg. To jest
   * cała wartość tej strony: sam plik mówi, co obowiązuje TERAZ, a raport sprzed pięciu dni
   * trzeba czytać razem z tym, co obowiązywało WTEDY.
   */
  protected readonly drift = computed<Drift[]>(() => {
    const snap = this.lastRun()?.config;
    if (!snap) return [];
    const now = this.values();
    return Object.entries(snap.values)
      .filter(([name, then]) => name in now && now[name] !== then)
      .map(([name, then]) => ({ name, then, now: now[name] ?? null }));
  });

  /** Progi, które w ostatnim przebiegu przyszły ze środowiska — jedyne bez śladu w historii. */
  protected readonly fromEnv = computed(() => this.lastRun()?.config?.fromEnv ?? []);

  protected readonly lastRunAt = computed(() => this.lastRun()?.startedAt ?? '');

  /** Raporty sprzed wprowadzenia migawki nie mają czego pokazać — mówimy to wprost. */
  protected readonly snapshotMissing = computed(
    () => this.data.runsDesc().length > 0 && !this.lastRun()?.config,
  );

  protected show(v: ConfigValue): string {
    if (v === null) return '—';
    if (typeof v === 'boolean') return v ? 'tak' : 'nie';
    return String(v);
  }
}
