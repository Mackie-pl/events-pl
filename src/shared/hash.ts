import { createHash } from "node:crypto";

/**
 * Klucz treści. Używany w dwóch miejscach o różnych konsekwencjach:
 *   - state.json: „czy strona się zmieniła" — decyduje, czy płacimy za wywołanie LLM,
 *   - archiwum: ścieżka obiektu, więc niezmieniona strona nie zajmuje drugi raz miejsca.
 * Zmiana algorytmu unieważnia oba cache'e naraz.
 */
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
