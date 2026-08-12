/**
 * Etap 3: digest wydarzeń na najbliższe dni — Telegram i/lub e-mail.
 *
 * Bez konfiguracji nadawców wypisuje treść na stdout (dry-run), więc da się go
 * bezpiecznie odpalić do podglądu. UWAGA: `npm run digest` ładuje .env, więc przy
 * ustawionym TELEGRAM_BOT_TOKEN NAPRAWDĘ wyśle. Do podglądu: npx tsx src/actions/digest.ts
 */
import { sendResend } from "../adapters/resend.js";
import { sendTelegram } from "../adapters/telegram.js";
import { P } from "../config/index.js";
import { buildDigest } from "../pipeline/digest/render.js";
import { todayWarsaw } from "../shared/dates.js";
import { eventsStore } from "../storage/index.js";

async function main(): Promise<void> {
  const data = await eventsStore.load();
  const childAge = P.DIGEST_CHILD_AGE.get();
  const digest = buildDigest(
    data,
    todayWarsaw(),
    Number.isNaN(childAge) ? null : childAge,
  );

  const sentTg = await sendTelegram(digest);
  const sentMail = await sendResend(digest);
  if (!sentTg && !sentMail) {
    console.log(
      "[dry-run] brak konfiguracji Telegram/Resend — digest poniżej:\n",
    );
    console.log(`SUBJECT: ${digest.subject}\n\n${digest.text}`);
  }
}

// uruchom tylko gdy odpalony bezpośrednio (nie przy imporcie sectionsFor/buildDigest w testach)
if (/digest\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
