/**
 * Tabela wszystkich parametrów wstrzykiwana do README między znaczniki.
 *
 * Wstrzykiwana, a nie doklejana, bo README to nie jest plik generowany — to proza, w której
 * nazwy zmiennych padają tam, gdzie tłumaczy się MECHANIZM (próg opłacalności FB, regulator
 * limitu, księga kosztów). Tamte wystąpienia zostają ręczne i tak ma być: generator nie umie
 * napisać akapitu o tym, czemu podłoga obsady gminy w ogóle istnieje. Generowana jest tylko
 * LISTA — jedyna część, która musi być kompletna i której kompletności nikt nie upilnuje ręcznie.
 *
 * Znaczniki są komentarzami HTML, więc na GitHubie ich nie widać.
 */
import { GROUPS } from "./groups.js";
import { ALL_PARAMS } from "./params.js";
import type { Param, ParamClass } from "./param.js";

export const BEGIN = "<!-- BEGIN GENERATED: config -->";
export const END = "<!-- END GENERATED: config -->";

const CLASS_LABEL: Record<ParamClass, string> = {
  secret: "sekret",
  setting: "ustawienie",
  tuning: "próg",
  endpoint: "adres",
  ambient: "środowisko",
};

/** Pionowa kreska rozjechałaby komórkę tabeli. */
const cell = (s: string): string => s.replaceAll("|", "\\|");

const defaultCell = (p: Param<unknown>): string =>
  p.defaultText === "" ? "brak" : `\`${cell(p.defaultText)}\``;

const tuningCount = (): number => ALL_PARAMS.filter((p) => p.cls === "tuning").length;

const row = (p: Param<unknown>): string =>
  `| \`${p.name}\` | ${defaultCell(p)} | ${CLASS_LABEL[p.cls]} | ${cell(p.summary)} |`;

export function renderReadmeConfig(): string {
  const out = [
    BEGIN,
    "",
    "<!-- Tabela poniżej jest generowana z src/config/params.ts przez `npm run config:docs`.",
    "     Ręczne zmiany przepadną — popraw wpis w rejestrze. -->",
    "",
    `Wszystkie ${ALL_PARAMS.length} parametrów, jakie potok czyta z konfiguracji. Kolumna **klasa** mówi,`,
    "czym parametr jest i — co ważniejsze — GDZIE mieszka:",
    "",
    `- **próg** (${tuningCount()} sztuk) — steruje zachowaniem potoku i stoi w commitowanym \`config.json\`.`,
    "  Zmiana progu ma zostawiać ślad: `git log -p config.json` daje datę, autora i wartość przed i po,",
    "  do zestawienia z tym, co w tych dniach robił potok. Każdy przebieg zapisuje w raporcie migawkę",
    "  progów, którymi się kierował (`RunReport.config`), więc stary raport da się czytać bez zgadywania.",
    "- **sekret** — klucz albo token, wyłącznie ze środowiska. Do repo nie trafia nigdy i `config.json`",
    "  go nie odczyta, nawet gdyby ktoś wpisał tam jego nazwę.",
    "- **ustawienie** — wybór właściciela (model, dostawca, adresat digestu), ze środowiska.",
    "- **adres** — punkt końcowy API; przydaje się przy proxy i mockach, normalnie zostaw domyślny.",
    "- **środowisko** — daje runner (GitHub Actions), nie ustawia się tego ręcznie.",
    "",
    "Pierwszeństwo: `process.env` → `config.json` → wartość domyślna. Env jest na górze, żeby doraźny",
    "eksperyment nie wymagał commita — kolumna **Domyślnie** pokazuje wartość z rejestru, czyli tę,",
    "która obowiązuje, gdy nie ustawiono nic. Dłuższe uzasadnienia stoją przy wpisach w `.env.example`.",
  ];

  for (const group of GROUPS) {
    const params = ALL_PARAMS.filter((p) => p.group === group.id);
    if (!params.length) continue;
    out.push(
      "",
      `**${group.title}**`,
      "",
      "| Parametr | Domyślnie | Klasa | Do czego |",
      "| --- | --- | --- | --- |",
      ...params.map(row),
    );
  }

  out.push("", END);
  return out.join("\n");
}

/**
 * Podmienia zawartość między znacznikami. Brak znaczników jest błędem, a nie cichym no-opem:
 * README bez nich znaczy, że ktoś je skasował razem z tabelą, i jedyne, co można wtedy zrobić,
 * to powiedzieć o tym głośno.
 */
export function applyReadmeConfig(readme: string): string {
  const from = readme.indexOf(BEGIN);
  const to = readme.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`README nie ma znaczników ${BEGIN} … ${END} — nie ma czego podmienić`);
  }
  // README jest pisany ręcznie, więc nie narzucamy mu końców linii przez .gitattributes —
  // zamiast tego wstawka dopasowuje się do gospodarza. Klon z autocrlf=true dostałby inaczej
  // plik z CRLF-ami wszędzie poza wygenerowaną tabelą.
  const block = readme.includes("\r\n")
    ? renderReadmeConfig().replaceAll("\n", "\r\n")
    : renderReadmeConfig();
  return readme.slice(0, from) + block + readme.slice(to + END.length);
}
