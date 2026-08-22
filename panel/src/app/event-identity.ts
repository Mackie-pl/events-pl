/**
 * Tożsamość wydarzenia w panelu — kopia `src/shared/event-key.ts`.
 *
 * Panel to osobna aplikacja i nie importuje z potoku, ale reguła musi zostać TA SAMA:
 * to po tym kluczu potok scalał rekordy, więc własna normalizacja pokazywałaby grupowanie,
 * którego nigdy nie było. Kopia żyje osobno od `format.ts`, bo używają jej dwie strony
 * (wyszukiwarka i strona źródła), a `format.ts` odpowiada za wygląd, nie za tożsamość.
 */
export const eventKey = (title: string, dateStart: string): string =>
  `${title.toLowerCase().replace(/\W+/g, '').slice(0, 40)}|${dateStart}`;

/**
 * Składanie polskich znaków do ASCII — po to, żeby „swieto" znajdowało „Święto".
 * `ł` nie ma formy rozłożonej w NFD i wymaga osobnej podmiany (ta sama pułapka co
 * w `src/reporting/fb-page-candidates.ts`), inaczej „Lubon" nie trafia w „Luboń".
 */
export const fold = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase();
