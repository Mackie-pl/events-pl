/**
 * Konfiguracja potoku — mirrors ../../../src/config/{meta-file,file,snapshot}.ts.
 *
 * Panel czyta DWA pliki, bo to dwie różne rzeczy: `config-meta.json` mówi, jakie parametry
 * w ogóle istnieją i czym są (rejestr), a `config.json` — jakie mają wartości. Rozdział nie
 * jest kosmetyczny: meta obejmuje wszystkie parametry, także sekrety, a wartości wyłącznie
 * progi. Wartości sekretów nie ma tu z czego wziąć i nie powinno być — pliki repo są publiczne.
 */

/** Do czego parametr służy; decyduje, czy panel w ogóle ma prawo znać jego wartość. */
export type ParamClass = 'secret' | 'setting' | 'tuning' | 'endpoint' | 'ambient';

/** JSON-owe skalary; `null` = „nie ustawiono". */
export type ConfigValue = string | number | boolean | null;

export interface ConfigMetaParam {
  name: string;
  group: string;
  cls: ParamClass;
  summary: string;
  /** wartość obowiązująca, gdy nie ustawiono ani env, ani config.json */
  def: ConfigValue;
}

export interface ConfigMeta {
  groups: { id: string; title: string }[];
  params: ConfigMetaParam[];
}

/** Zawartość config.json: progi plus klucz `_` z notką dla czytającego plik ręcznie. */
export type ConfigFile = Record<string, ConfigValue>;

/** Migawka progów zapisana w raporcie przebiegu (RunReport.config). */
export interface ConfigSnapshot {
  values: Record<string, ConfigValue>;
  /** progi, które w tym przebiegu przyszły ze środowiska, nie z pliku */
  fromEnv?: string[];
}
