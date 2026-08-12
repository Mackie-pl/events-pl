/** Wysyłka digestu e-mailem przez Resend. Brak klucza = cicho pomijamy. */
import { P } from "../config/index.js";
import type { Digest } from "../pipeline/digest/render.js";

import { fetchUrl } from "./http.js";

export async function sendResend(d: Digest): Promise<boolean> {
  const key = P.RESEND_API_KEY.get();
  const to = P.DIGEST_TO.get();
  if (!key || !to) return false;
  const res = await fetchUrl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: P.DIGEST_FROM.get(),
      to: [to],
      subject: d.subject,
      text: d.text,
      html: d.html,
    }),
  }, 30_000);
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`Email: wysłano do ${to}: ${d.subject}`);
  return true;
}
