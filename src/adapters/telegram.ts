/** Wysyłka digestu na Telegrama. Brak tokenu = cicho pomijamy (tryb dry-run). */
import { P } from "../config/index.js";
import type { Digest } from "../pipeline/digest/render.js";

import { fetchUrl } from "./http.js";

export async function sendTelegram(d: Digest): Promise<boolean> {
  const token = P.TELEGRAM_BOT_TOKEN.get();
  const chatId = P.TELEGRAM_CHAT_ID.get();
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
