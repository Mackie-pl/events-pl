/**
 * Normalizacja adresów — lustro `src/shared/url.ts`.
 *
 * Kopia, nie import: panel jest osobną instalacją npm i nie sięga do drzewa potoku (tak samo
 * jak `fmtProbe`, które celowo istnieje w obu miejscach). Reguła musi zostać ta sama, bo służy
 * do TEGO SAMEGO porównania — łączenia wyniku wyszukiwarki z propozycją i ze źródłem. Gdyby
 * się rozjechała, ślad „to trafienie stało się tym źródłem" cicho by się rwał.
 */
export function urlKey(u: string): string {
  try {
    const p = new URL(u);
    const host = p.host.replace(/^www\./i, '').toLowerCase();
    const path = p.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...p.searchParams.entries()]
      .filter(([, v]) => !v.includes('{page}')) // paginacja to nie inne źródło
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return host + path + (params ? `?${params}` : '');
  } catch {
    return u
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

export function host(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}
