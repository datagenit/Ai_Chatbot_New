import AutomationRule from "../models/AutomationRule.js";
import AdminCredentials from "../models/AdminCredentials.js";
import { assignAgent, addLabel, sendTemplate } from "../services/cpaas.js";

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

// ── Template variable resolver ────────────────────────────────────────────────

function resolveTemplateVars(
  params: Record<string, string>,
  vars: { mobile: string; message: string; brandNumber: string }
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = value
      .replace(/\{\{user_name\}\}/g, vars.mobile)
      .replace(/\{\{user_input\}\}/g, vars.message)
      .replace(/\{\{agent_name\}\}/g, "AI Agent")
      .replace(/\{\{brand_number\}\}/g, vars.brandNumber);
  }
  return resolved;
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

    const lower = message.toLowerCase();
    const detectedSentiment = detectSentiment(message);
    console.log(
      `[Automations] adminId=${adminId} mobile=${mobile} sentiment=${detectedSentiment} rules=${rules.length}`
    );

    for (const rule of rules) {
      // trigger_template docs have no trigger/action — skip them
      if (!rule.trigger || !rule.action) continue;

      // skip action execution if no credentials
      if (!credentials) continue;

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

    // ── Trigger Templates — intent matching ──────────────────────────────
    if (!credentials) {
      console.warn(`[TriggerTemplates] No CPaaS credentials for adminId: ${adminId} — skipping templates`);
      return { matched: false, rule: null };
    }

    const triggerTemplates = await AutomationRule.find({
      adminId,
      ruleType: "trigger_template",
      enabled: true,
    });

    for (const tmpl of triggerTemplates) {
      const tc = tmpl.triggerConfig;
      if (!tc) continue;

      // only intent type handled inline — no_reply/stage need scheduler
      if (tc.triggerType !== "intent") continue;

      const keywords = tc.keywords ?? [];
      const matched = keywords.some((kw) => lower.includes(kw.toLowerCase()));
      if (!matched) continue;

      // cooldown check
      const lastFiredMap = tc.lastFired as Map<string, Date>;
      const lastFiredAt = lastFiredMap?.get(mobile);
      if (lastFiredAt) {
        const cooldownMs = (tc.cooldownHours ?? 24) * 60 * 60 * 1000;
        if (Date.now() - lastFiredAt.getTime() < cooldownMs) {
          console.log(`[TriggerTemplates] Cooldown active for "${tmpl.name}" → ${mobile}`);
          continue;
        }
      }

      console.log(`[TriggerTemplates] Firing "${tmpl.name}" → ${mobile}`);

      try {
        if (!tc.template) {
          console.warn(`[TriggerTemplates] No template config for "${tmpl.name}" — skipping`);
          continue;
        }

        const vars = {
          mobile,
          message,
          brandNumber: credentials.brandNumber ?? "",
        };

        const resolvedBodyParams = resolveTemplateVars(
          Object.fromEntries(tc.template.bodyParams ?? new Map()),
          vars
        );
        const resolvedHeaderParams = resolveTemplateVars(
          Object.fromEntries(tc.template.headerParams ?? new Map()),
          vars
        );

        await sendTemplate({
          user_id: credentials.user_id,
          token: credentials.token,
          mobile,
          wid: tc.template.wid,
          templateName: tc.template.templateName ?? "",
          bodyParams: resolvedBodyParams,
          headerParams: resolvedHeaderParams,
          mediaUrl: tc.template.mediaUrl ?? "",
          brandNumber: credentials.brandNumber ?? "",
          createdByName: "AI Agent",
          createdById: credentials.user_id,
        });

        // update lastFired for cooldown tracking
        await AutomationRule.updateOne(
          { _id: tmpl._id },
          { $set: { [`triggerConfig.lastFired.${mobile}`]: new Date() } }
        );

        console.log(`[TriggerTemplates] Sent and lastFired updated for "${tmpl.name}"`);
      } catch (tmplErr) {
        console.error(
          `[TriggerTemplates] Failed to send template "${tmpl.name}":`,
          tmplErr instanceof Error ? tmplErr.message : tmplErr
        );
      }

      // do NOT break — fire ALL matching templates
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
