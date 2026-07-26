/**
 * Implementacja portu składowania oparta o pliki JSON w repo — jedyna, jaką dziś mamy.
 *
 * Dwie zasady, które muszą przetrwać ewentualną zamianę na bazę:
 *   - uszkodzony plik NIE wywraca przebiegu (discover kosztuje kilka dolarów, daily płatne
 *     wywołania LLM) — logujemy i zaczynamy od pustej historii, poprzednia wersja i tak
 *     zostaje w gicie,
 *   - zapis idzie przez JSON.stringify(x, null, 1): jedna spacja wcięcia daje diffy
 *     czytelne w code review, a plik i tak jest maszynowy.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { describeError } from "../shared/errors.js";

import type { CollectionStore, DocStore, Envelope, Retention } from "./types.js";

const INDENT = 1;

async function readJson(path: string, label: string): Promise<unknown> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch (e) {
    console.warn(`${label} nie do odczytania (${describeError(e)}) — zaczynam od pustego`);
    return undefined;
  }
}

/** Dokument JSON: cały plik to jedna wartość. */
export function jsonDoc<T>(path: string, fallback: () => T, opts: { pretty?: boolean } = {}): DocStore<T> {
  const label = path.split(/[\\/]/).pop() ?? path;
  return {
    async load() {
      const raw = await readJson(path, label);
      return raw === undefined ? fallback() : (raw as T);
    },
    async save(value) {
      await writeFile(path, JSON.stringify(value, null, opts.pretty === false ? undefined : INDENT), "utf-8");
    },
  };
}

/** Zastosuj retencję do pełnej, posortowanej listy rekordów. Wydzielone, bo to jedyna logika warta testu. */
export function applyRetention<T>(records: T[], r: Retention<T>): T[] {
  const sorted = [...records].sort((a, b) => r.at(a).localeCompare(r.at(b)));

  let kept = sorted;
  if (r.cutoff) {
    const limit = r.cutoff();
    const age = r.ageKey ?? r.at;
    const recent = sorted.filter((x) => age(x) >= limit);
    // minKeep wygrywa z wiekiem: po przerwie w cronie wszystko jest „za stare",
    // a raport bez punktu odniesienia jest bezużyteczny
    kept = recent.length >= (r.minKeep ?? 0) ? recent : sorted.slice(-(r.minKeep ?? 0));
  }
  if (r.maxKeep !== undefined) kept = kept.slice(-r.maxKeep);

  if (r.slim) {
    const { keepDetailed, slim } = r.slim;
    kept = kept.map((x, i) => (i < kept.length - keepDetailed ? slim(x) : x));
  }
  return kept;
}

/** Kolekcja JSON; `envelope` dla plików trzymających rekordy obok metadanych (costs.json). */
export function jsonCollection<T>(
  path: string,
  retention: Retention<T>,
  envelope?: Envelope<T>,
): CollectionStore<T> {
  const label = path.split(/[\\/]/).pop() ?? path;
  return {
    async all() {
      const raw = await readJson(path, label);
      if (raw === undefined) return [];
      const list = envelope ? envelope.unwrap(raw) : raw;
      if (!Array.isArray(list)) return [];
      return retention.normalize ? list.map(retention.normalize) : (list as T[]);
    },
    async append(records) {
      if (!records.length) return;
      const prev = await this.all();
      // rekord o tym samym kluczu zastępuje poprzedni, zamiast się dokleić —
      // powtórzony zapis raportu nie ma podwajać kwoty w księdze
      const key = retention.key;
      const incoming = key ? new Set(records.map(key)) : null;
      const replaced = key && incoming ? prev.filter((x) => !incoming.has(key(x))) : prev;
      const kept = applyRetention([...replaced, ...records], retention);
      const body = envelope ? envelope.wrap(kept) : kept;
      await writeFile(path, JSON.stringify(body, null, INDENT), "utf-8");
    },
  };
}
