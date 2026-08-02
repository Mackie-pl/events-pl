/**
 * Tożsamość wydarzenia — klucz, po którym `dedupe` scala rekordy z różnych źródeł.
 *
 * Mieszka w `shared/`, bo mają go używać DWA miejsca i muszą używać tego samego: potok
 * (scalanie w trakcie przebiegu) i raport plonu (`--yield`, liczący z runs.json, które
 * źródło dało coś, czego nie dało żadne inne). Gdyby raport miał własną normalizację,
 * mierzyłby nakładanie inne niż to, które faktycznie zaszło — i doradzałby usunięcie
 * źródła na podstawie duplikatów, których potok nigdy nie scalił.
 *
 * Znane ograniczenie, świadomie NIE naprawiane tutaj: `\W+` bez flagi `u` zjada polskie
 * znaki („Święto" → „wito"), a obcięcie do 40 znaków sklei tytuły o wspólnym początku.
 * Zmiana tej funkcji zmienia wynik scalania w całym potoku, więc jest osobną decyzją —
 * `--yield` raportuje ją jako zastrzeżenie, zamiast po cichu liczyć po swojemu.
 */
export const eventKey = (title: string | null | undefined, dateStart: string): string =>
  `${(title ?? "").toLowerCase().replace(/\W+/g, "").slice(0, 40)}|${dateStart}`;
