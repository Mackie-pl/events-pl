/**
 * Werdykt geokodera — wspólne słownictwo dla adaptera (`adapters/nominatim.ts`), cache'u
 * w state.json i odsiewu (`pipeline/locality.ts`).
 *
 * Mieszka w types/, a nie przy adapterze, bo pytanie „gdzie to leży" jest pojęciem
 * dziedzinowym: state i EventItem muszą je znać, a nie wolno im zależeć od adaptera.
 */

/**
 * Gdzie leży miejsce. Cztery odpowiedzi, bo różnią się tym, co wolno na ich podstawie zrobić:
 *   - `region`  — w naszym prostokącie (albo miejscowość jest nasza, a adresu OSM nie zna),
 *   - `far`     — istnieje, w Polsce, ale poza regionem — dziś WYŁĄCZNIE do pomiaru,
 *   - `abroad`  — za granicą: wycieczka biura podróży, nie wydarzenie, na które się przychodzi,
 *   - `unknown` — geokoder nie wie nic, więc i my nie wiemy, i nic z tym nie robimy.
 */
export type GeoWhere = "region" | "far" | "abroad" | "unknown";

/** Pinezka TYLKO z regionu, plus odpowiedź na pytanie „a jeśli nie, to gdzie". */
export interface GeoVerdict {
  pin: { lat: number; lon: number } | null;
  where: GeoWhere;
  /** nazwa z OSM przy `far`/`abroad` — bez niej ślad mówi „poza regionem" i nic więcej */
  place?: string;
}
