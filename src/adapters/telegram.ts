/** Wysyłka digestu na Telegrama. Brak tokenu = cicho pomijamy (tryb dry-run). */
import type { Digest } from "../pipeline/digest/render.js";

import { fetchUrl } from "./http.js";

export async function sendTelegram(d: Digest): Promise<boolean> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) return false;
  for (const text of d.tgMessages) {
    const res = await fetchUrl(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
      30_000,
      "Telegram sendMessage", // label: URL zawiera token bota — nie do logów
    );
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  }
  console.log(
    `Telegram: wysłano ${d.tgMessages.length} wiadomości (${d.total} pozycji)`,
  );
  return true;
}
