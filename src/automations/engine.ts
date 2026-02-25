import AutomationRule from "../models/AutomationRule.js";
import AdminCredentials from "../models/AdminCredentials.js";
import { assignAgent, addLabel } from "../services/cpaas.js";

// ── Simple local sentiment classifier ─────────────────────────────────────────

const NEGATIVE_KEYWORDS = [
  "angry", "frustrated", "worst", "terrible", "useless",
  "bad", "horrible", "hate", "pathetic", "disappointed",
];

const POSITIVE_KEYWORDS = [
  "great", "good", "happy", "love", "excellent",
  "amazing", "thank", "awesome", "perfect",
];

type Sentiment = "positive" | "negative" | "neutral";

function detectSentiment(message: string): Sentiment {
  const lower = message.toLowerCase();
  if (NEGATIVE_KEYWORDS.some((kw) => lower.includes(kw))) return "negative";
  if (POSITIVE_KEYWORDS.some((kw) => lower.includes(kw))) return "positive";
  return "neutral";
}

// ── Engine result type ─────────────────────────────────────────────────────────

export interface AutomationResult {
  matched: boolean;
  rule: string | null;
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runAutomations(
  adminId: string,
  message: string,
  mobile: string
): Promise<AutomationResult> {
  try {
    // Load only enabled rules for this admin, in insertion order
    const rules = await AutomationRule.find({ adminId, enabled: true }).sort({
      createdAt: 1,
    });

    if (rules.length === 0) {
      return { matched: false, rule: null };
    }

    // Load CPaaS credentials
    const credentials = await AdminCredentials.findOne({ adminId });
    if (!credentials) {
      console.warn(
        `[Automations] No CPaaS credentials found for adminId: ${adminId} — skipping`
      );
      return { matched: false, rule: null };
    }

    const lower = message.toLowerCase();
    const detectedSentiment = detectSentiment(message);
    console.log(
      `[Automations] adminId=${adminId} mobile=${mobile} sentiment=${detectedSentiment} rules=${rules.length}`
    );

    for (const rule of rules) {
      let triggered = false;

      // ── Evaluate trigger ─────────────────────────────────────────────────
      if (rule.trigger.type === "keyword") {
        const keywords = rule.trigger.keywords ?? [];
        triggered = keywords.some((kw) => lower.includes(kw.toLowerCase()));
      } else if (rule.trigger.type === "sentiment") {
        triggered = rule.trigger.sentiment === detectedSentiment;
      }

      if (!triggered) continue;

      console.log(
        `[Automations] Rule matched: "${rule.name}" (${rule.trigger.type}) → action: ${rule.action.type}="${rule.action.value}"`
      );

      // ── Execute action ───────────────────────────────────────────────────
      try {
        if (rule.action.type === "assign_agent") {
          const result = await assignAgent({
            user_id: credentials.user_id,
            token: credentials.token,
            email: credentials.email,
            mobile,
            value: rule.action.value,
          });
          console.log(`[Automations] assignAgent result:`, result);
        } else if (rule.action.type === "assign_label") {
          const result = await addLabel({
            user_id: credentials.user_id,
            token: credentials.token,
            mobile,
            value: rule.action.value,
          });
          console.log(`[Automations] addLabel result:`, result);
        }
      } catch (actionErr) {
        console.error(
          `[Automations] Action failed for rule "${rule.name}":`,
          actionErr instanceof Error ? actionErr.message : actionErr
        );
      }

      // Only first matching rule fires
      return { matched: true, rule: rule.name };
    }

    return { matched: false, rule: null };
  } catch (err) {
    console.error(
      "[Automations] Engine error:",
      err instanceof Error ? err.message : err
    );
    return { matched: false, rule: null };
  }
}
