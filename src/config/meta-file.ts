/**
 * `config-meta.json` — rejestr w postaci, którą umie przeczytać panel.
 *
 * Panel to osobny projekt npm z własnym node_modules i własnym tsconfigiem; typy z `src/`
 * odwzorowuje ręcznie (patrz panel/src/app/types-*.ts), więc importu `params.ts` nie zrobi.
 * Zamiast wyłamywać tę granicę, wystawiamy to samo, co i tak stoi w tabeli README, jako plik
 * — panel pobiera go dokładnie tak jak runs.json czy costs.json, także z GitHub Pages.
 *
 * CO TU NIE WCHODZI: żadnych WARTOŚCI poza domyślnymi. Wartości progów są w config.json,
 * a wartości sekretów i ustawień żyją w środowisku i panel nie ma prawa ich zobaczyć —
 * plik jest publiczny tak samo jak reszta repo.
 */
import { GROUPS } from "./groups.js";
import { ALL_PARAMS } from "./params.js";
import type { ConfigValue } from "./file.js";
import type { ParamClass } from "./param.js";

export interface ConfigMetaParam {
  name: string;
  group: string;
  cls: ParamClass;
  summary: string;
  /** wartość obowiązująca, gdy nie ustawiono ani env, ani config.json */
  def: ConfigValue;
}

export interface ConfigMeta {
  /** kolejność i nagłówki sekcji — te same, co w .env.example i w README */
  groups: Array<{ id: string; title: string }>;
  params: ConfigMetaParam[];
}

export function buildConfigMeta(): ConfigMeta {
  return {
    groups: GROUPS.map((g) => ({ id: g.id, title: g.title })),
    params: ALL_PARAMS.map((p) => ({
      name: p.name,
      group: p.group,
      cls: p.cls,
      summary: p.summary,
      def: p.defaultJson,
    })),
  };
}

export const renderConfigMeta = (): string => `${JSON.stringify(buildConfigMeta(), null, 2)}\n`;
