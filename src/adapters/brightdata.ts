/**
 * Klient Bright Data Web Scraper API (datasets v3), tryb asynchroniczny:
 *   trigger  → poll progress → download snapshot.
 *
 * Używany do dwóch rzeczy w pipeline:
 *   1) rozwiązywania linków do wydarzeń FB (facebook.com/events/…) → dane wydarzenia,
 *   2) scrapowania postów z otwartych grup FB jako źródeł wydarzeń.
 *
 * Rozliczenie Bright Data jest per-REKORD (rząd ~$1–1.5 / 1000 rekordów dla FB),
 * dlatego liczymy trigger/URL/rekordy w `bdUsage` i logujemy na końcu przebiegu
 * (daily.ts → brightdata-usage.jsonl), żeby dało się policzyć koszt.
 *
 * Env:
 *   BRIGHTDATA_API_KEY         (wymagany; brak → FB pomijane, tryb zero-cost)
 *   BD_DATASET_FB_EVENTS       (opc.) domyślnie gd_m14sd0to1jz48ppm51
 *   BD_DATASET_FB_GROUP_POSTS  (opc.) domyślnie gd_lz11l67o2cb3r0lkj3
 *   BD_POLL_MS                 (opc.) interwał pollingu, domyślnie 10000
 *   BD_TIMEOUT_MS              (opc.) limit oczekiwania na snapshot, domyślnie 480000 (8 min)
 */
import { setTimeout as sleep } from "node:timers/promises";

import { P } from "../config/index.js";
import { fetchUrl } from "./http.js";
import type { BdUsage } from "../types/index.js";

const BASE = "https://api.brightdata.com/datasets/v3";

/** ID gotowych scraperów Bright Data (nadpisywalne env-em na wypadek zmian po stronie BD). */
export const BD_DATASETS = {
  fbEvents: P.BD_DATASET_FB_EVENTS.get(),
  fbGroupPosts: P.BD_DATASET_FB_GROUP_POSTS.get(),
  /** `""` = nieustawione. Fanpage'e są poza daily; czyta to wyłącznie sonda `probe-fb-pages`. */
  fbPagePosts: P.BD_DATASET_FB_PAGE_POSTS.get() ?? "",
} as const;

export type BdRecord = Record<string, unknown>;

/** Współdzielony licznik zużycia w ramach jednego przebiegu. */
export const bdUsage: BdUsage = {
  triggers: 0, inputs: 0, polls: 0, records: 0, errors: 0, snapshots: [], byDataset: {},
};

/** Nazwa datasetu do rozbicia kosztu; nieznane id (nadpisane env-em) zostaje samo sobą. */
const datasetName = (id: string): string =>
  Object.entries(BD_DATASETS).find(([, v]) => v === id)?.[0] ?? id;

/**
 * Kopia licznika „na teraz". Rozliczenie BD jest per-rekord, więc żeby powiedzieć
 * „ta jedna grupa kosztowała 300 rekordów", trzeba zmierzyć różnicę wokół wywołania —
 * sam licznik zbiorczy pokazuje tylko, że przebieg był drogi.
 */
export const bdSnapshot = (): BdUsage =>
  ({ ...bdUsage, snapshots: [...bdUsage.snapshots], byDataset: { ...bdUsage.byDataset } });

/** Przyrost względem migawki. `null` = nic nie zużyto (pole `bd` nie pojawia się w raporcie). */
export function bdDelta(before: BdUsage): BdUsage | null {
  const byDataset: Record<string, number> = {};
  for (const [k, v] of Object.entries(bdUsage.byDataset ?? {})) {
    const d = v - (before.byDataset?.[k] ?? 0);
    if (d) byDataset[k] = d;
  }
  const delta: BdUsage = {
    triggers: bdUsage.triggers - before.triggers,
    inputs: bdUsage.inputs - before.inputs,
    polls: bdUsage.polls - before.polls,
    records: bdUsage.records - before.records,
    errors: bdUsage.errors - before.errors,
    snapshots: bdUsage.snapshots.slice(before.snapshots.length),
    byDataset,
  };
  return delta.triggers || delta.records || delta.errors ? delta : null;
}

export function bdEnabled(): boolean {
  return Boolean(P.BRIGHTDATA_API_KEY.get());
}

function authHeaders(): Record<string, string> {
  const key = P.BRIGHTDATA_API_KEY.get();
  if (!key) throw new Error("Brak BRIGHTDATA_API_KEY");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function trigger(
  datasetId: string, inputs: Array<{ url: string }>, limitPerInput?: number,
): Promise<string> {
  bdUsage.triggers += 1;
  bdUsage.inputs += inputs.length;
  const limitParam = limitPerInput ? `&limit_per_input=${limitPerInput}` : "";
  const res = await fetchUrl(
    `${BASE}/trigger?dataset_id=${datasetId}&include_errors=true${limitParam}`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(inputs), // datasets v3 /trigger przyjmuje gołą tablicę inputów
    },
    60_000,
    `Bright Data trigger ${datasetId}`,
  );
  const json = (await res.json().catch(() => ({}))) as { snapshot_id?: string; error?: string; message?: string };
  if (!res.ok || !json.snapshot_id) {
    const why = json.error ?? json.message ?? JSON.stringify(json).slice(0, 200);
    throw new Error(`Bright Data trigger ${res.status}: ${why}`);
  }
  return json.snapshot_id;
}

async function progress(snapshotId: string): Promise<string> {
  bdUsage.polls += 1;
  const res = await fetchUrl(
    `${BASE}/progress/${snapshotId}`,
    { headers: authHeaders() },
    30_000,
    `Bright Data progress ${snapshotId}`,
  );
  const json = (await res.json().catch(() => ({}))) as { status?: string };
  return json.status ?? "unknown";
}

/**
 * Bright Data rozlicza za czas/rekordy niezależnie od tego, czy klient jeszcze słucha —
 * porzucona migawka (np. po naszym timeout) leci dalej i płynie kasa bez żadnego wyniku
 * po naszej stronie. Wołane best-effort: nieudane anulowanie nie powinno przykryć
 * właściwego błędu timeoutu.
 */
async function cancelSnapshot(snapshotId: string): Promise<void> {
  try {
    await fetchUrl(
      `${BASE}/snapshot/${snapshotId}/cancel`,
      { method: "POST", headers: authHeaders() },
      15_000,
      `Bright Data cancel ${snapshotId}`,
    );
  } catch {
    // best-effort — brak anulowania nie powinien zgłuszyć oryginalnego błędu timeoutu
  }
}

async function download(snapshotId: string): Promise<BdRecord[]> {
  const res = await fetchUrl(
    `${BASE}/snapshot/${snapshotId}?format=json`,
    { headers: authHeaders() },
    120_000,
    `Bright Data snapshot ${snapshotId}`,
  );
  if (!res.ok) throw new Error(`Bright Data snapshot ${res.status}`);
  const json: unknown = await res.json().catch(() => []);
  return Array.isArray(json) ? (json as BdRecord[]) : [];
}

/**
 * Pełny cykl dla zbioru URL-i tego samego datasetu.
 * Zwraca surowe rekordy (przy include_errors mogą zawierać wpisy z polem błędu — filtruje warstwa FB).
 */
export async function collect(
  datasetId: string, urls: string[], limitPerInput?: number,
): Promise<BdRecord[]> {
  const uniq = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (!uniq.length) return [];

  const pollMs = P.BD_POLL_MS.get();
  const timeoutMs = P.BD_TIMEOUT_MS.get();

  const snapshotId = await trigger(datasetId, uniq.map((url) => ({ url })), limitPerInput);
  // od razu po triggerze — id nieudanego/przeterminowanego zbioru też chcemy mieć w logu
  bdUsage.snapshots.push(snapshotId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(pollMs);
    let status: string;
    try {
      status = await progress(snapshotId);
    } catch {
      status = "running"; // chwilowy błąd sieci — próbujemy dalej do timeoutu
    }
    if (status === "ready") break;
    if (status === "failed") throw new Error(`Bright Data snapshot ${snapshotId} failed`);
    if (Date.now() > deadline) {
      // porzucona migawka płynie dalej i kosztuje bez wyniku (patrz cancelSnapshot) —
      // anulujemy, żeby nie płacić za coś, czego już nie odbieramy
      await cancelSnapshot(snapshotId);
      throw new Error(`Bright Data snapshot ${snapshotId} timeout (status=${status}) — anulowano`);
    }
  }

  const rows = await download(snapshotId);
  bdUsage.records += rows.length;
  const name = datasetName(datasetId);
  bdUsage.byDataset = { ...bdUsage.byDataset, [name]: (bdUsage.byDataset?.[name] ?? 0) + rows.length };
  return rows;
}
