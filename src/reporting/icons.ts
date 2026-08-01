/**
 * Ikony werdyktów. Osobny moduł, bo używa ich i podsumowanie przebiegu (reporting),
 * i tryb --why (pipeline) — trzymanie ich w podsumowaniu odwracałoby kierunek zależności.
 */
import type { SourceProposal, SourceVerification } from "../types/index.js";

export const OUTCOME_ICON: Record<SourceVerification["outcome"], string> = {
  ok: "✅", fixed: "🔧", dead: "💀", error: "⚠️", skipped: "⏭️",
};

export const DECISION_ICON: Record<SourceProposal["decision"], string> = {
  added: "➕", confirmed: "🔗", duplicate: "♻️", "low-confidence": "🤏", invalid: "🚫",
};
