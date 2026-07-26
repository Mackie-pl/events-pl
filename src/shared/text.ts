/** Drobne operacje na napisach współdzielone przez etapy. */

/** Przycięcie z wielokropkiem — raporty i podsumowania nie mogą puchnąć od jednego pola. */
export const trim = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ż: "z", ź: "z",
};

/**
 * id musi być stabilne i bezpieczne: jest kluczem cache ekstrakcji w state.json.
 * Zmiana tej funkcji unieważnia cache wszystkich źródeł naraz — nie „porządkować" jej mimochodem.
 */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ąćęłńóśżź]/g, (c) => PL_MAP[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Niepusty string albo undefined — normalizacja pól z JSON-a od modelu. */
export const str = (v: unknown): string | undefined =>
  (typeof v === "string" && v.trim() ? v.trim() : undefined);
