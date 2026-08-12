/**
 * Maszyneria rejestru parametrów. Same deklaracje są w `params.ts` — tutaj tylko to,
 * co je czyta i typuje.
 *
 * Dwie decyzje warte zapamiętania:
 *
 *   1. WSZYSTKO JEST LENIWE. `get()` czyta `process.env` przy każdym wywołaniu, a nie przy
 *      ładowaniu modułu. Wcześniej połowa progów była stałą modułową (`const MAX_TOKENS =
 *      Number(process.env[...])`), przez co kolejność importów decydowała o wartości —
 *      stąd hack w check-structured.ts z dynamicznym importem PO ustawieniu flagi. Koszt
 *      parsowania przy każdym odczycie jest nieistotny (kilkaset wywołań na przebieg).
 *
 *   2. PUSTY STRING TO BRAK WARTOŚCI. GitHub Actions wstawia nieustawiony secret jako `""`,
 *      a `Number("")` to 0 — czyli `EXTRACT_MAX_TOKENS` bez sekretu w repo dawało sufit 0
 *      tokenów zamiast domyślnych 12 000. Każdy parser dostaje surowiec już po `trim()`,
 *      z pustym zamienionym na `undefined`.
 *
 * Wartość spoza dopuszczalnego zakresu NIE wywraca przebiegu — wraca domyślna. To świadome:
 * potok chodzi nocą z crona, a literówka w progu ma kosztować domyślne zachowanie, nie dobę
 * bez danych. Zrzut konfiguracji pokazuje, co faktycznie obowiązuje.
 */
import { configValue } from "./file.js";
import type { ConfigValue } from "./file.js";
import type { GroupId } from "./groups.js";

/**
 * Do czego parametr służy — decyduje o maskowaniu w zrzutach i o tym, co kiedyś pojedzie
 * do `config.json`, a co musi zostać sekretem środowiska.
 *
 *   secret    klucz/token — nigdy nie pokazujemy wartości
 *   setting   wybór właściciela projektu (model, dostawca, adresat digestu)
 *   tuning    próg sterujący zachowaniem potoku — kandydat do wersjonowania w repo
 *   endpoint  adres API, nadpisywalny dla proxy/mocka
 *   ambient   daje je środowisko (GitHub Actions), my tylko czytamy
 */
export type ParamClass = "secret" | "setting" | "tuning" | "endpoint" | "ambient";

export interface ParamMeta {
  readonly group: GroupId;
  readonly cls: ParamClass;
  /**
   * Jedna linia: CO ten parametr robi. Wymagana, bo to ona trafia do tabeli w README
   * i jako komentarz obok wpisu w .env.example — parametr bez niej byłby w obu miejscach
   * samą nazwą i liczbą. Trzymaj poniżej ~80 znaków, zaczynaj małą literą.
   */
  readonly summary: string;
  /** DLACZEGO tak, gdy jedna linia nie wystarcza — blok prozy nad wpisem w .env.example. */
  readonly doc?: readonly string[];
  /** Co pokazać po `=`. Domyślnie tekst wartości domyślnej. */
  readonly example?: string;
  /** Renderuj bez `#`, jako lukę do wypełnienia po skopiowaniu pliku do .env. */
  readonly fill?: boolean;
}

/** Skąd wzięła się wartość, którą właśnie oddał `get()`. */
export type ParamSource = "env" | "config.json" | "domyślna";

export interface Param<T> extends ParamMeta {
  readonly name: string;
  /** Wartość domyślna jako tekst — do .env.example i do tabeli w README. */
  readonly defaultText: string;
  /** Ta sama wartość domyślna jako skalar JSON — do zasiewania config.json. */
  readonly defaultJson: ConfigValue;
  get(): T;
  /**
   * Wartość bez pochodzenia nie wystarcza do diagnozy: „próg wynosi 30" nie mówi, czy ktoś
   * go tak ustawił, czy po prostu nikt go nie ruszał. To ta różnica jest odpowiedzią na
   * połowę pytań o zachowanie przebiegu.
   */
  source(): ParamSource;
}

/** Konstruktor czeka na nazwę, którą wstrzyknie `defineParams` z klucza obiektu. */
type Ctor<T> = (name: string) => Param<T>;

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t === undefined || t === "" ? undefined : t;
};

/**
 * Pierwszeństwo: `process.env` → `config.json` → wartość domyślna. Plik obsługuje wyłącznie
 * progi (`tuning`) — reszta klas ignoruje go nawet wtedy, gdy ktoś tam wpisze ich nazwy
 * (patrz file.ts).
 */
const ctor = <T>(
  meta: ParamMeta, def: ConfigValue, parse: (raw: string | undefined) => T,
): Ctor<T> => (name) => ({
  ...meta,
  name,
  defaultText: def === null ? "" : String(def),
  defaultJson: def,
  get: () => parse(clean(process.env[name]) ?? configValue(name, meta.cls)),
  source: () => {
    if (clean(process.env[name]) !== undefined) return "env";
    return configValue(name, meta.cls) !== undefined ? "config.json" : "domyślna";
  },
});

const finite = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};

/** Tekst z wartością domyślną. */
export const text = (o: ParamMeta & { def: string }): Ctor<string> =>
  ctor(o, o.def, (raw) => raw ?? o.def);

/** Tekst bez domyślnej: `undefined` znaczy „nie ustawiono", a nie „pusty". */
export const optText = (o: ParamMeta): Ctor<string | undefined> =>
  ctor(o, null, (raw) => raw);

/** Liczba dodatnia. `0` i wartości ujemne wracają do domyślnej — patrz `num` dla progów, gdzie 0 ma sens. */
export const posNum = (o: ParamMeta & { def: number }): Ctor<number> =>
  ctor(o, o.def, (raw) => {
    const v = finite(raw);
    return v !== null && v > 0 ? v : o.def;
  });

/** Liczba z dolnym progiem WŁĄCZNIE — dla stawek i sufitów, gdzie `0` jest poprawną wartością. */
export const num = (o: ParamMeta & { def: number; min: number }): Ctor<number> =>
  ctor(o, o.def, (raw) => {
    const v = finite(raw);
    return v !== null && v >= o.min ? v : o.def;
  });

/** Liczba dodatnia albo `null` — brak wartości WYŁĄCZA mechanizm, zamiast go domyślnie ustawiać. */
export const optPosNum = (o: ParamMeta): Ctor<number | null> =>
  ctor(o, null, (raw) => {
    const v = finite(raw);
    return v !== null && v > 0 ? v : null;
  });

/** Liczba całkowita od `min` włącznie albo `null`. */
export const optInt = (o: ParamMeta & { min: number }): Ctor<number | null> =>
  ctor(o, null, (raw) => {
    const v = finite(raw);
    return v !== null && Number.isInteger(v) && v >= o.min ? v : null;
  });

/** Lista po przecinku, małymi literami, bez pustych. Wartość ustawiona na pustą = lista pusta. */
export const csv = (o: ParamMeta & { def: readonly string[] }): Ctor<readonly string[]> =>
  ctor(o, o.def.join(","), (raw) => {
    if (raw === undefined) return o.def;
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  });

/**
 * Wybór z zamkniętej listy. Wartość spoza listy wraca do domyślnej.
 *
 * Dwa zabiegi na typach, oba po to, żeby `get()` oddawał wąską unię, a nie `string` — inaczej
 * miejsce użycia musi się bronić przed wartościami, które rejestr już odsiał:
 *   `const V`  — bierze literały z listy bez `as const` przy każdej deklaracji,
 *   `NoInfer`  — nie pozwala wnioskować V także z `def` (skończyłoby się na wspólnym `string`).
 */
export const oneOf = <const V extends string>(
  o: ParamMeta & { values: readonly V[]; def: NoInfer<V> },
): Ctor<V> => ctor(o, o.def, (raw) => {
  const v = raw?.toLowerCase() as V | undefined;
  return v !== undefined && o.values.includes(v) ? v : o.def;
});

/** Włączone, dopóki ktoś nie wpisze `0`. Domyślnie WŁĄCZONE — do wyłączników, nie do włączników. */
export const offWhenZero = (o: ParamMeta): Ctor<boolean> =>
  ctor(o, true, (raw) => raw !== "0");

/**
 * Buduje rejestr, wstrzykując nazwę zmiennej z klucza obiektu. Dzięki temu nazwa istnieje
 * w jednym egzemplarzu — nie da się mieć klucza `FB_MUTE_DAYS` czytającego `FB_MUTE_DAYZ`.
 * Typ zwracany jest mapowany, więc każdy klucz zachowuje swój konkretny `Param<T>`.
 */
export function defineParams<M extends Record<string, Ctor<unknown>>>(
  m: M,
): { [K in keyof M]: ReturnType<M[K]> } {
  const out: Record<string, Param<unknown>> = {};
  for (const [name, make] of Object.entries(m)) out[name] = make(name);
  return out as { [K in keyof M]: ReturnType<M[K]> };
}
