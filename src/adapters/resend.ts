/** Wysyłka digestu e-mailem przez Resend. Brak klucza = cicho pomijamy. */
import type { Digest } from "../pipeline/digest/render.js";

import { fetchUrl } from "./http.js";

export async function sendResend(d: Digest): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  const to = process.env["DIGEST_TO"];
  if (!key || !to) return false;
  const res = await fetchUrl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env["DIGEST_FROM"] ?? "events-pl <onboarding@resend.dev>",
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
