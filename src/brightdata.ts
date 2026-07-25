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

import { fetchUrl } from "./errors.js";
import type { BdUsage } from "./types.js";

const BASE = "https://api.brightdata.com/datasets/v3";

/** ID gotowych scraperów Bright Data (nadpisywalne env-em na wypadek zmian po stronie BD). */
export const BD_DATASETS = {
  fbEvents: process.env["BD_DATASET_FB_EVENTS"] ?? "gd_m14sd0to1jz48ppm51",
  fbGroupPosts: process.env["BD_DATASET_FB_GROUP_POSTS"] ?? "gd_lz11l67o2cb3r0lkj3",
} as const;

export type BdRecord = Record<string, unknown>;

/** Współdzielony licznik zużycia w ramach jednego przebiegu. */
export const bdUsage: BdUsage = { triggers: 0, inputs: 0, polls: 0, records: 0, errors: 0, snapshots: [] };

export function bdEnabled(): boolean {
  return Boolean(process.env["BRIGHTDATA_API_KEY"]);
}

function authHeaders(): Record<string, string> {
  const key = process.env["BRIGHTDATA_API_KEY"];
  if (!key) throw new Error("Brak BRIGHTDATA_API_KEY");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function trigger(datasetId: string, inputs: Array<{ url: string }>): Promise<string> {
  bdUsage.triggers += 1;
  bdUsage.inputs += inputs.length;
  const res = await fetchUrl(
    `${BASE}/trigger?dataset_id=${datasetId}&include_errors=true`,
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
    throw new Error(`Bright Data trigger ${res.status}: ${json.error ?? json.message ?? JSON.stringify(json).slice(0, 200)}`);
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
export async function collect(datasetId: string, urls: string[]): Promise<BdRecord[]> {
  const uniq = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (!uniq.length) return [];

  const pollMs = Number(process.env["BD_POLL_MS"] ?? 10_000);
  const timeoutMs = Number(process.env["BD_TIMEOUT_MS"] ?? 480_000);

  const snapshotId = await trigger(datasetId, uniq.map((url) => ({ url })));
  bdUsage.snapshots.push(snapshotId); // od razu po triggerze — id nieudanego/przeterminowanego zbioru też chcemy mieć w logu
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
    if (Date.now() > deadline) throw new Error(`Bright Data snapshot ${snapshotId} timeout (status=${status})`);
  }

  const rows = await download(snapshotId);
  bdUsage.records += rows.length;
  return rows;
}
