/**
 * Kształt propozycji źródła — to samo, o co prosi DISCOVERY_SYSTEM, tyle że dla maszyny.
 *
 * Powód istnienia jest datowany. Luboń, 2026-08-02: model zaproponował 17 źródeł, a w polu
 * `why` piętnastego napisał „Wydarzenia w Luboniu" — polski cudzysłów otwierający, ASCII
 * zamykający — i urwał tym literał JSON-a. Do rejestru weszło 14 propozycji, przepadły
 * wszystkie trzy grupy FB, czyli JEDYNE źródła FB, które daily w ogóle pobiera.
 *
 * Ekstrakcja ma na to lekarstwo od 2026-08-01 (`response_format`; ta sama awaria jest opisana
 * słowo w słowo w adapters/openrouter.ts). Discovery nigdy nie zostało podłączone: `chat()`
 * przyjmował `schema`, a discover-town.ts go nie podawał — czyli jedyny etap potoku, który
 * dopisuje do rejestru, jechał bez zabezpieczenia, które reszta ma od dnia wcześniej.
 *
 * Konwencje trybu strict jak w types/event-schema.ts: obiekty zamknięte, KAŻDE pole wymagane,
 * „brak" wyrażony pustym stringiem (nie pominięciem klucza). Wartości dopuszczalne dla `type`
 * i `fetch` idą przez `enum`, nie przez unię literałów: unia liczy się do twardego limitu
 * Anthropic (16 pól unijnych), a `enum` nie kosztuje nic.
 *
 * Schemat NIE zastępuje toSource(). Wymusza kształt, nie sens — `url` zgodny ze schematem
 * dalej bywa nazwą domeny bez schematu, a `fetch:"plain"` pod adresem grupy FB dalej trzeba
 * poprawić na `fb_group`.
 */
import { type Static, Type } from "@sinclair/typebox";

import { closed } from "../shared/json-schema.js";
import type { FetchStrategy, SourceType } from "./source.js";

/**
 * Wartości dopuszczalne — JEDNA lista dla schematu (co wolno modelowi) i dla to-source.ts
 * (co wpuszczamy do rejestru). Rozjechanie się tych dwóch byłoby ciche w najgorszy sposób:
 * schemat przepuszczałby wartość, którą walidacja i tak zamienia na „venue"/„plain",
 * a w raporcie zostawałaby po tym tylko linijka `fixes`.
 */
export const SOURCE_TYPES: readonly SourceType[] = [
  "city_portal", "culture_center", "library", "sports", "venue",
  "fb_page", "fb_group", "rss", "api", "pdf_program",
];

export const FETCH_STRATEGIES: readonly FetchStrategy[] = [
  "plain", "headless", "pdf", "api", "fb", "fb_group", "fb_event", "rss",
];

const CONFIDENCE_NOTE = "0-1: na ile jesteś pewien, że pod tym adresem są wydarzenia z datami";
const WHY_NOTE = "JEDNO zdanie po polsku: co w wyniku wyszukiwania o tym przesądziło";
const NOTES_NOTE = 'uwaga dla człowieka czytającego rejestr; "" gdy nie ma nic do dodania';

export const SourceProposalSchema = closed({
  id: Type.String({ description: "krótki identyfikator: małe litery i myślniki" }),
  name: Type.String({ description: "nazwa instytucji albo serwisu" }),
  type: Type.Unsafe<SourceType>({ type: "string", enum: [...SOURCE_TYPES] }),
  url: Type.String({ description: "pełny adres http(s)" }),
  town: Type.String({ description: "miejscowość, dla której to źródło publikuje" }),
  fetch: Type.Unsafe<FetchStrategy>({ type: "string", enum: [...FETCH_STRATEGIES] }),
  confidence: Type.Number({ description: CONFIDENCE_NOTE }),
  why: Type.String({ description: WHY_NOTE }),
  notes: Type.String({ description: NOTES_NOTE }),
});

/** Całość odpowiedzi discovery — to ten schemat idzie do `response_format`. */
export const DiscoverySchema = closed({
  sources: Type.Array(SourceProposalSchema),
});

export type ProposedSource = Static<typeof SourceProposalSchema>;
