import axios from "axios";
import _ from "lodash";
import Workflow from "../models/Workflow.js";
import WorkflowSession from "../models/WorkflowSession.js";
import AdminCredentials from "../models/AdminCredentials.js";
import UsageLog from "../models/UsageLog.js";
import ExecutionLog from "../models/ExecutionLog.js";
import GlobalVariable from "../models/GlobalVariable.js";
import { sendTemplate, getCredentials, sendTextMessage, sendTextWithButtons, sendListMessage, sendMediaMessage, assignAgent, addLabel } from "../services/cpaas.js";
import { runAgent } from "../agent/index.js";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import AdminConfig from "../models/AdminConfig.js";
import { retrieve } from "../ingestion/retriever.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTemplate(text: string, variables: Record<string, unknown>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? `{{${key}}}` : String(value);
  });
}

function resolvePath(obj: unknown, path: string): string {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return "";
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined && current !== null ? String(current) : "";
}

// ── Pure branch evaluator (shared by condition + loop exit) ───────────────────

function evaluateBranch(
  operator: string | undefined,
  actual: string,
  expected: string | undefined
): boolean {
  switch (operator) {
    case "equals":       return actual === (expected ?? "");
    case "not_equals":   return actual !== (expected ?? "");
    case "contains":     return actual.includes(expected ?? "");
    case "not_contains": return !actual.includes(expected ?? "");
    case "exists":       return actual.length > 0;
    default:             return false;
  }
}

// ── Dynamic list-row builder ──────────────────────────────────────────────────

function buildDynamicRows(
  raw: string,
  sectionTitle: string
): Array<{ title: string; rows: Array<{ id: string; title: string; description: string }> }> {
  try {
    const parsed = JSON.parse(raw);
    const items: unknown[] = Array.isArray(parsed) ? parsed : [];

    const rows = items.map((item, i) => {
      if (typeof item === "string" || typeof item === "number") {
        const val = String(item);
        return { id: val, title: val, description: "" };
      }
      const obj = item as Record<string, unknown>;
      const id =
        String(obj["id"] ?? obj["code"] ?? obj["key"] ?? i);
      const title =
        String(obj["title"] ?? obj["name"] ?? obj["label"] ?? obj["value"] ?? id);
      const description =
        String(obj["description"] ?? obj["desc"] ?? obj["subtitle"] ?? "");
      return { id, title, description };
    });

    return [{ title: sectionTitle || "Options", rows }];
  } catch {
    return [];
  }
}

// ── Fuzzy AI classifier ───────────────────────────────────────────────────────

async function classifyWithAI(
  userInput: string,
  labels: string[],
  adminId: string,
  threadId: string
): Promise<string | null> {
  const startTime = Date.now();
  try {
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash",
      temperature: 0,
      apiKey: process.env.GOOGLE_API_KEY,
    });
    const prompt = `You are a classifier. Given the user message and a list of categories,
reply with ONLY the single category label that best matches the user message.
If nothing matches, reply with the word: none

Categories:
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}

User message: "${userInput}"

Reply with only the matching category label or "none".`;

    const result = await llm.invoke([{ role: "user", content: prompt }]);
    const latencyMs = Date.now() - startTime;

    const usage = (result as any).response_metadata?.usage ??
                  (result as any).usage_metadata ?? {};
    const inputTokens  = usage.input_tokens  ?? usage.prompt_tokens  ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const totalTokens  = usage.total_tokens  ?? (inputTokens + outputTokens);

    UsageLog.create({
      adminId,
      threadId,
      modelName: "gemini-2.5-flash",
      inputTokens,
      outputTokens,
      totalTokens,
      source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
      latencyMs,
      status: "success",
    }).catch((err) => console.error("[UsageLog] Failed to save usage:", err));

    const matched = String(result.content).trim();
    return labels.find(
      (l) => l.toLowerCase() === matched.toLowerCase()
    ) ?? null;
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    console.error("[WorkflowEngine] classifyWithAI failed:",
      err instanceof Error ? err.message : err);
    UsageLog.create({
      adminId,
      threadId,
      modelName: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
      latencyMs,
      status: "error",
    }).catch(() => {});
    return null;
  }
}

// ── Validation helper ─────────────────────────────────────────────────────────

function evaluateValidation(
  value: string,
  validationType: string,
  step: Record<string, unknown>
): boolean {
  try {
    switch (validationType) {
      case "text":
        return true;
      case "phone":
        return /^\d{10,15}$/.test(value);
      case "email":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      case "date": {
        const d = new Date(value);
        return !isNaN(d.getTime());
      }
      case "number": {
        const n = Number(value);
        if (isNaN(n)) return false;
        const min = step["min"] as number | undefined;
        const max = step["max"] as number | undefined;
        if (min !== undefined && n < min) return false;
        if (max !== undefined && n > max) return false;
        return true;
      }
      case "regex": {
        const pattern = step["pattern"] as string | undefined;
        if (!pattern) return true;
        return new RegExp(pattern).test(value);
      }
      default:
        return true;
    }
  } catch {
    return false;
  }
}

// ── Execution log helpers (fire-and-forget, never throw) ──────────────────────

async function logStepEntry(
  logId: string | null,
  stepId: string,
  stepType: string,
  input: string
): Promise<void> {
  if (!logId) return;
  try {
    await ExecutionLog.findByIdAndUpdate(logId, {
      $push: {
        steps: {
          stepId,
          stepType,
          enteredAt: new Date(),
          exitedAt:  null,
          status:    "waiting",
          input:     input || null,
          output:    null,
          error:     null,
          nextStepId: null,
          retryCount: 0,
        },
      },
    });
  } catch (e) {
    console.error("[ExecutionLog] step entry failed:", e instanceof Error ? e.message : e);
  }
}

async function logStepExit(
  logId: string | null,
  status: "completed" | "waiting" | "error",
  output: string | null,
  nextStepId: string | null,
  retryCount: number,
  error?: string | null
): Promise<void> {
  if (!logId) return;
  try {
    const $set: Record<string, unknown> = {
      "steps.$[last].exitedAt":   new Date(),
      "steps.$[last].status":     status,
      "steps.$[last].output":     output,
      "steps.$[last].nextStepId": nextStepId,
      "steps.$[last].retryCount": retryCount,
    };
    if (error != null) {
      $set["steps.$[last].error"] = error;
    }
    await ExecutionLog.findByIdAndUpdate(
      logId,
      { $set },
      { arrayFilters: [{ "last.exitedAt": null }] }
    );
  } catch (e) {
    console.error("[ExecutionLog] step exit failed:", e instanceof Error ? e.message : e);
  }
}

// ── Stale button / menu reply detector ───────────────────────────────────────

async function detectStaleButtonReply(
  input: string,
  session: any,
  workflow: any
): Promise<{ staleStep: any; matchedValue: string; matchedLabel: string } | null> {
  if (!session.waitingForInput) return null;

  const inTrim = String(input ?? "").trim();
  if (!inTrim) return null;
  const inLower = inTrim.toLowerCase();

  const steps = workflow.steps ?? [];
  const skipId = session.currentStepId;

  // Two-pass matching:
  // 1) Title-only pass — user-visible text (typed or echoed) is unambiguous.
  // 2) Id-only pass — WhatsApp list replies send row ids; many menus reuse "row_1".
  //    Scan steps in *reverse* so deeper / later-defined menus win over the root menu.

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.id === skipId) continue;

    if (step.type === "send_interactive") {
      const buttons = step.interactiveConfig?.buttons || [];
      const match = buttons.find(
        (b: any) =>
          String(b.title ?? "").toLowerCase().trim() === inLower
      );
      if (match) {
        return {
          staleStep: step,
          matchedValue: String(match.id),
          matchedLabel: String(match.title ?? match.id ?? ""),
        };
      }
    }

    if (step.type === "send_menu") {
      const sections = step.menuConfig?.sections || [];
      for (const section of sections) {
        for (const r of section.rows ?? []) {
          if (String(r.title ?? "").toLowerCase().trim() === inLower) {
            return {
              staleStep: step,
              matchedValue: String(r.id ?? r.title ?? ""),
              matchedLabel: String(r.title ?? r.id ?? ""),
            };
          }
        }
      }
    }
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.id === skipId) continue;

    if (step.type === "send_interactive") {
      const buttons = step.interactiveConfig?.buttons || [];
      const match = buttons.find((b: any) => String(b.id ?? "") === inTrim);
      if (match) {
        return {
          staleStep: step,
          matchedValue: String(match.id),
          matchedLabel: String(match.title ?? match.id ?? ""),
        };
      }
    }

    if (step.type === "send_menu") {
      const sections = step.menuConfig?.sections || [];
      for (const section of sections) {
        for (const r of section.rows ?? []) {
          if (String(r.id ?? "") === inTrim) {
            return {
              staleStep: step,
              matchedValue: String(r.id),
              matchedLabel: String(r.title ?? r.id ?? ""),
            };
          }
        }
      }
    }
  }

  return null;
}

// ── AI Intent Guard helpers ───────────────────────────────────────────────────

function buildWorkflowContext(
  session: any,
  workflow: any,
  currentStepQuestion: string
): string {
  const collected: Record<string, string> = {};
  session.collectedData?.forEach((v: string, k: string) => {
    if (
      !k.startsWith("__retries_") &&
      !k.startsWith("__loop_") &&
      !k.startsWith("__menu_reply_")
    ) {
      collected[k] = v;
    }
  });

  const collectedStr =
    Object.keys(collected).length > 0
      ? Object.entries(collected)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "none yet";

  return (
    `[mid-workflow context] Workflow: "${workflow.name}". ` +
    `Current step is asking: "${currentStepQuestion}". ` +
    `Data collected so far: ${collectedStr}.`
  );
}

async function isOffTopicMessage(
  input: string,
  stepQuestion: string,
  validOptions: string[],
  adminId: string,
  threadId: string
): Promise<boolean> {
  try {
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-2.0-flash",
      temperature: 0,
      maxOutputTokens: 5,
      apiKey: process.env.GOOGLE_API_KEY,
    });

    const optionsLine =
      validOptions.length > 0
        ? `Valid options: ${validOptions.join(", ")}`
        : "Any free-form text is acceptable.";

    const prompt =
      `Step question: "${stepQuestion}"\n` +
      `${optionsLine}\n` +
      `User replied: "${input}"\n\n` +
      `Is this reply completely unrelated to the step question? ` +
      `Reply with only YES or NO.`;

    const result = await llm.invoke([{ role: "user", content: prompt }]);
    const answer = (result.content as string).trim().toUpperCase();

    const usage =
      (result as any).response_metadata?.usage_metadata ??
      (result as any).usage_metadata;
    if (usage) {
      const inputTokens =
        usage.input_token_count ?? usage.prompt_token_count ?? 0;
      const outputTokens =
        usage.output_token_count ?? usage.candidates_token_count ?? 0;
      UsageLog.create({
        adminId,
        threadId,
        modelName: "gemini-2.0-flash",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
        latencyMs: 0,
        status: "success",
      }).catch(() => {});
    }

    return answer.startsWith("YES");
  } catch (err) {
    console.error(
      "[AIIntentGuard] isOffTopicMessage error — defaulting to false:",
      err
    );
    return false;
  }
}

async function handleOffTopicReply(
  input: string,
  stepQuestion: string,
  workflowContext: string,
  adminId: string,
  threadId: string,
  session: any
): Promise<void> {
  try {
    const enrichedInput = `${workflowContext}\n\nUser question: ${input}`;

    const result = await runAgent(adminId, enrichedInput, threadId);

    const messages = result.messages ?? [];
    let ragAnswer = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const isAI =
        msg instanceof AIMessage ||
        (typeof (msg as any)._getType === "function" &&
          (msg as any)._getType() === "ai") ||
        (msg as any).role === "assistant";
      if (!isAI) continue;
      const hasToolCalls =
        "tool_calls" in (msg as any) &&
        Array.isArray((msg as any).tool_calls) &&
        (msg as any).tool_calls.length > 0;
      if (hasToolCalls) continue;
      if (
        typeof (msg as any).content === "string" &&
        (msg as any).content.trim()
      ) {
        ragAnswer = (msg as any).content.trim();
        break;
      }
    }

    if (/^\d{10,15}$/.test(threadId)) {
      const creds = await getCredentials(adminId);
      if (creds && ragAnswer) {
        await sendTextMessage({
          credentials: creds,
          mobile: session.threadId,
          message: ragAnswer,
        });
      }
    }

    if (/^\d{10,15}$/.test(threadId)) {
      const creds = await getCredentials(adminId);
      if (creds && stepQuestion) {
        await sendTextMessage({
          credentials: creds,
          mobile: session.threadId,
          message: stepQuestion,
        });
      }
    }

    console.log(
      `[AIIntentGuard] Off-topic handled for session ${session._id}. ` +
      `RAG answered, step re-prompted.`
    );
  } catch (err) {
    console.error("[AIIntentGuard] handleOffTopicReply error:", err);
  }
}

// ── Session V2 awaiting-state helpers ─────────────────────────────────────────

function setAwaitingState(
  session: any,
  payload: {
    stepId: string;
    type: "send_menu" | "send_interactive" | "collect_input";
    promptText?: string;
    validReplyIds?: string[];
    validReplyLabels?: string[];
  }
) {
  session.awaitingStepId = payload.stepId;
  session.awaitingType = payload.type;
  session.promptText = payload.promptText ?? "";
  session.validReplyIds = payload.validReplyIds ?? [];
  session.validReplyLabels = payload.validReplyLabels ?? [];
}

function clearAwaitingState(session: any) {
  session.awaitingStepId = null;
  session.awaitingType = null;
  session.promptText = "";
  session.validReplyIds = [];
  session.validReplyLabels = [];
}

function matchesAwaitingState(
  session: any,
  step: any,
  expectedType: "send_menu" | "send_interactive" | "collect_input"
): boolean {
  return (
    session.waitingForInput === true &&
    session.awaitingStepId === step.id &&
    session.awaitingType === expectedType
  );
}

function canUseLegacyAwaitingFallback(session: any, step: any): boolean {
  return (
    session.waitingForInput === true &&
    (!session.awaitingStepId || !session.awaitingType) &&
    session.currentStepId === step.id
  );
}

function repairAwaitingStateFromStep(
  session: any,
  step: any,
  payload: {
    type: "send_menu" | "send_interactive" | "collect_input";
    promptText?: string;
    validReplyIds?: string[];
    validReplyLabels?: string[];
  }
) {
  setAwaitingState(session, {
    stepId: step.id,
    type: payload.type,
    promptText: payload.promptText ?? "",
    validReplyIds: payload.validReplyIds ?? [],
    validReplyLabels: payload.validReplyLabels ?? [],
  });
}

function applyStaleSelectionToSession(
  session: any,
  staleMatch: {
    staleStep: any;
    matchedValue: string;
    matchedLabel: string;
  }
) {
  const staleStep = staleMatch.staleStep;
  const replyKey = `__menu_reply_${staleStep.id}`;
  const titleKey = `__menu_reply_${staleStep.id}_title`;

  session.collectedData.set(replyKey, staleMatch.matchedValue);
  session.collectedData.set(titleKey, staleMatch.matchedLabel);
  session.markModified("collectedData");

  clearAwaitingState(session);
  session.waitingForInput = false;
  session.currentStepId = staleStep.nextStep ?? "END";
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runWorkflow(
  threadId: string,
  adminId: string,
  lastMessage: string
): Promise<{ text: string; preview: object | null; resolvedInput?: string }> {
  try {
    const session = await WorkflowSession.findOne({ threadId, done: false });
    if (!session) return { text: "", preview: null };

    if (session.currentStepId === "END") {
      session.done = true;
      await session.save();
      return { text: "", preview: null };
    }

    const workflow = await Workflow.findById(session.workflowId);
    if (!workflow) {
      session.done = true;
      await session.save();
      return { text: "", preview: null };
    }

    // Load workflow settings for timeout, then reset expiry on every user interaction
    const workflowForTimeout = await Workflow.findById(session.workflowId).lean();
    const timeoutMinutes = (workflowForTimeout as any)?.timeoutMinutes ?? 30;
    session.lastActivityAt = new Date();
    session.expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    // ── Execution log: create or resume log for this session ──────────────────
    let executionLogId: string | null = null;
    try {
      const existingLog = await ExecutionLog.findOne({
        sessionId: session._id.toString(),
      });
      if (existingLog) {
        executionLogId = String(existingLog._id);
      } else {
        const newLog = await ExecutionLog.create({
          adminId,
          workflowId:   workflow._id.toString(),
          workflowName: workflow.name,
          sessionId:    session._id.toString(),
          threadId,
          startedAt:    new Date(),
          status:       "running",
          steps:        [],
        });
        executionLogId = String(newLog._id);
      }
    } catch (logErr) {
      console.error(
        "[ExecutionLog] init failed:",
        logErr instanceof Error ? logErr.message : logErr
      );
    }

    // ── Load global variables for this admin ──────────────────────────────────
    // Loaded once before the loop; collectedData always wins on key collision.
    const globalData: Record<string, string> = {};
    try {
      const globalVars = await GlobalVariable.find({ adminId }).lean();
      for (const g of globalVars) {
        globalData[g.key] = g.value;
      }
    } catch (globErr) {
      console.error(
        "[WorkflowEngine] GlobalVariable.find failed:",
        globErr instanceof Error ? globErr.message : globErr
      );
    }

    let outboundMsg: string | null = null;
    let sentViaCpaas = false;
    let lastPreview: object | null = null;
    let resolvedInput: string | undefined = undefined;
    let continueLoop = true;

    while (continueLoop) {
      console.log('[Engine] step:', session.currentStepId, '| waitingForInput:',
        session.waitingForInput, '| lastMessage:', lastMessage);
      if (session.currentStepId === "END") {
        session.done = true;
        break;
      }

      const step = workflow.steps.find((s) => s.id === session.currentStepId);
      if (!step) {
        session.done = true;
        break;
      }

      // Priority (lowest → highest): globals → collectedData → last_message.
      // Internal __retries_* keys are filtered; __loop_* kept for loop counter reads.
      const data: Record<string, unknown> = {
        ...globalData,
        ...Object.fromEntries(
          [...(session.collectedData ?? new Map()).entries()].filter(
            ([k]) => !k.startsWith("__retries_")
          )
        ),
        last_message: lastMessage,
      };

      switch (step.type as any) {
        // ── message ─────────────────────────────────────────────────────────
        case "message": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const messageText = resolveTemplate(step.message ?? "", data);
          outboundMsg = messageText;

          if (/^\d{10,15}$/.test(threadId)) {
            const creds = await getCredentials(adminId);
            if (creds) {
              await sendTextMessage({
                credentials: creds,
                mobile: session.threadId,
                message: messageText,
              });
              sentViaCpaas = true;
            }
          }

          session.currentStepId = step.nextStep ?? "END";
          continueLoop = false;
          await logStepExit(executionLogId, "completed", messageText.slice(0, 200), session.currentStepId, 0);
          break;
        }

        // ── send_interactive ──────────────────────────────────────────────────
        case "send_interactive": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const ic = step.interactiveConfig;
          const messageText = resolveTemplate(ic?.message ?? "", data);
          const buttons = (ic?.buttons ?? []).map((b: any) => {
            const rawId = String(b?.id ?? b?.reply?.id ?? b?.title ?? b?.label ?? "");
            const resolvedId = resolveTemplate(rawId, data);
            const fallbackTitle = String(b?.title ?? b?.label ?? b?.reply?.title ?? "");
            return {
              id: resolvedId,
              title: resolveTemplate(fallbackTitle, data),
            };
          });

          const sendInteractiveCpaas = async () => {
            if (!/^\d{10,15}$/.test(threadId)) return;
            const creds = await getCredentials(adminId);
            if (!creds) return;
            try {
              await sendTextWithButtons({
                credentials: creds,
                mobile: session.threadId,
                message: messageText,
                buttons,
              });
              sentViaCpaas = true;
            } catch (interactiveErr) {
              console.error(
                "[WorkflowEngine] send_interactive failed:",
                interactiveErr instanceof Error ? interactiveErr.message : interactiveErr
              );
            }
          };

          if (!session.waitingForInput || session.currentStepId !== step.id) {
            outboundMsg = messageText;
            lastPreview = {
              type: "interactive",
              body: messageText,
              buttons: buttons.map((b: { id: string; title: string }) => ({ id: b.id, title: b.title })),
            };
            await sendInteractiveCpaas();
            session.waitingForInput = true;
            session.currentStepId = step.id;
            setAwaitingState(session, {
              stepId: step.id,
              type: "send_interactive",
              promptText: messageText,
              validReplyIds: buttons.map((b: any) => String(b.id)),
              validReplyLabels: buttons.map((b: any) => String(b.title)),
            });
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
            break;
          }

          // ── V2 / legacy phase-2 gate ──────────────────────────────────────
          {
            let isV2Match = matchesAwaitingState(session, step, "send_interactive");
            const isLegacyMatch = canUseLegacyAwaitingFallback(session, step);

            if (!isV2Match && isLegacyMatch) {
              // Self-heal: old/inconsistent session — repair V2 state without resending
              repairAwaitingStateFromStep(session, step, {
                type: "send_interactive",
                promptText: messageText,
                validReplyIds: buttons.map((b: any) => String(b.id)),
                validReplyLabels: buttons.map((b: any) => String(b.title)),
              });
              await session.save();
              isV2Match = true;
            }

            if (!isV2Match && !isLegacyMatch) {
              // V2 awaiting state is for a different step — re-run Phase 1
              outboundMsg = messageText;
              lastPreview = {
                type: "interactive",
                body: messageText,
                buttons: buttons.map((b: { id: string; title: string }) => ({
                  id: b.id,
                  title: b.title,
                })),
              };
              await sendInteractiveCpaas();
              session.waitingForInput = true;
              session.currentStepId = step.id;
              setAwaitingState(session, {
                stepId: step.id,
                type: "send_interactive",
                promptText: messageText,
                validReplyIds: buttons.map((b: any) => String(b.id)),
                validReplyLabels: buttons.map((b: any) => String(b.title)),
              });
              continueLoop = false;
              await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
              break;
            }
          }

          // --- STALE BUTTON DETECTION ---
          {
            // Only run stale detection when input does NOT match the current step's own buttons.
            // This prevents false positives when multiple steps share the same button/row id
            // (e.g. every menu has a "row_1" entry).
            const rawInputCheck = String(lastMessage ?? "").trim().toLowerCase();
            const isCurrentStepInput =
              buttons.some((b: any) => String(b.id).toLowerCase() === rawInputCheck) ||
              buttons.some(
                (b: any) => (b.title ?? "").toLowerCase().trim() === rawInputCheck
              );

            if (!isCurrentStepInput) {
              const staleMatch = await detectStaleButtonReply(lastMessage, session, workflow);
              if (staleMatch) {
                console.log(
                  `[WorkflowEngine] Stale reply detected. Consuming selection immediately ` +
                  `for session ${session._id}, stale step "${staleMatch.staleStep.id}" ` +
                  `→ nextStep "${staleMatch.staleStep.nextStep ?? "END"}"`
                );

                // Remove internal keys that belong to steps after the stale step
                const retryKeysToRemove: string[] = [];
                session.collectedData.forEach((_: any, key: string) => {
                  if (
                    key.startsWith("__retries_") ||
                    key.startsWith("__menu_reply_") ||
                    key.startsWith("__loop_")
                  ) {
                    const keyStepId = key
                      .replace("__retries_", "")
                      .replace("__menu_reply_", "")
                      .replace(/_title$/, "")
                      .replace("__loop_", "")
                      .replace(/_count$/, "");
                    if (keyStepId !== staleMatch.staleStep.id) {
                      retryKeysToRemove.push(key);
                    }
                  }
                });
                retryKeysToRemove.forEach((k) => session.collectedData.delete(k));

                // Consume the stale selection immediately — no Phase 1 resend
                applyStaleSelectionToSession(session, staleMatch);
                session.lastActivityAt = new Date();
                session.expiresAt = new Date(
                  Date.now() + (workflow.timeoutMinutes || 30) * 60 * 1000
                );
                await session.save();

                continueLoop = true;
                continue;
              }
            }
          }
          // --- END STALE BUTTON DETECTION ---

          const rawInput = String(lastMessage ?? "").trim();
          const buttonIds = buttons.map((b: { id: string }) => String(b.id).toLowerCase());
          const labelMap: Record<string, string> = {};
          buttons.forEach((b: { id: string; title: string }) => {
            const id = String(b.id || b.title);
            const label = String(b.title || b.id);
            labelMap[id.toLowerCase()] = label;
          });

          // --- AI INTENT GUARD: send_interactive ---
          {
            const siQuestion = resolveTemplate(ic?.message ?? "", data);
            const buttonTitles = buttons.map(
              (b: { id: string; title: string }) => b.title
            );

            const siOffTopic = await isOffTopicMessage(
              rawInput,
              siQuestion,
              buttonTitles,
              adminId,
              threadId
            );

            if (siOffTopic) {
              const wfContext = buildWorkflowContext(session, workflow, siQuestion);
              await handleOffTopicReply(
                rawInput,
                siQuestion,
                wfContext,
                adminId,
                threadId,
                session
              );
              session.lastActivityAt = new Date();
              await session.save();
              continueLoop = false;
              await logStepExit(
                executionLogId,
                "waiting",
                "off-topic handled by RAG",
                session.currentStepId,
                0
              );
              break;
            }
          }
          // --- END AI INTENT GUARD ---

          if (buttonIds.length > 0 && !buttonIds.includes(rawInput.toLowerCase())) {
            await sendInteractiveCpaas();
            outboundMsg = messageText;
            lastPreview = {
              type: "interactive",
              body: messageText,
              buttons: buttons.map((b: { id: string; title: string }) => ({ id: b.id, title: b.title })),
            };
            session.waitingForInput = true;
            session.currentStepId = step.id;
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "invalid selection", session.currentStepId, 0);
            break;
          }

          const resolvedLabel = labelMap[rawInput.toLowerCase()] ?? rawInput;
          const autoReplyKey = `__menu_reply_${step.id}`;
          session.collectedData.set(autoReplyKey, rawInput);
          session.collectedData.set(`${autoReplyKey}_title`, resolvedLabel);
          if (step.saveResponseTo) {
            session.collectedData.set(step.saveResponseTo, resolvedLabel);
          }
          const replyStepId = session.awaitingStepId ?? step.id;
          resolvedInput = session.collectedData.get(`__menu_reply_${replyStepId}_title`) as string | undefined;
          session.markModified("collectedData");
          clearAwaitingState(session);
          session.waitingForInput = false;
          // Per-button routing: if the matched button has its own nextStep, use it;
          // otherwise fall back to the step-level nextStep.
          const matchedBtn = (ic?.buttons ?? []).find((b: any) => {
            const rawId = String(b?.id ?? b?.reply?.id ?? b?.title ?? b?.label ?? "");
            return resolveTemplate(rawId, data).toLowerCase() === rawInput.toLowerCase();
          });
          const btnNextStep = String((matchedBtn as any)?.nextStep ?? "").trim();
          session.currentStepId = btnNextStep || step.nextStep || "END";
          continueLoop = true;
          await logStepExit(executionLogId, "completed", "interactive selection", session.currentStepId, 0);
          break;
        }

        // ── collect_input ────────────────────────────────────────────────────
        case "collect_input": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const promptText = resolveTemplate(step.prompt ?? step.inputPrompt ?? "", data);
          const varKey = step.variable ?? step.inputKey ?? "input";

          if (!session.waitingForInput || session.currentStepId !== step.id) {
            if (!promptText) {
              // No prompt — collect the current incoming message immediately
              clearAwaitingState(session);
              session.collectedData.set(varKey, String(lastMessage ?? "").trim());
              session.markModified("collectedData");
              session.waitingForInput = false;
              session.currentStepId = step.nextStep ?? "END";
              continueLoop = true;
              await logStepExit(executionLogId, "completed", `collected immediately: ${varKey}`, session.currentStepId, 0);
              break;
            }
            outboundMsg = promptText;
            lastPreview = { type: "text", body: promptText };
            if (/^\d{10,15}$/.test(threadId)) {
              const creds = await getCredentials(adminId);
              if (creds) {
                await sendTextMessage({
                  credentials: creds,
                  mobile: session.threadId,
                  message: promptText,
                });
                sentViaCpaas = true;
              }
            }
            session.waitingForInput = true;
            session.currentStepId = step.id;
            setAwaitingState(session, {
              stepId: step.id,
              type: "collect_input",
              promptText,
              validReplyIds: [],
              validReplyLabels: Array.isArray(step.validOptions) ? (step.validOptions as string[]) : [],
            });
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for input", session.currentStepId, 0);
            break;
          }

          // ── V2 / legacy phase-2 gate ──────────────────────────────────────
          {
            let isV2Match = matchesAwaitingState(session, step, "collect_input");
            const isLegacyMatch = canUseLegacyAwaitingFallback(session, step);

            if (!isV2Match && isLegacyMatch) {
              // Self-heal: old/inconsistent session — repair V2 state without resending
              repairAwaitingStateFromStep(session, step, {
                type: "collect_input",
                promptText,
                validReplyIds: [],
                validReplyLabels: Array.isArray(step.validOptions) ? (step.validOptions as string[]) : [],
              });
              await session.save();
              isV2Match = true;
            }

            if (!isV2Match && !isLegacyMatch) {
              // V2 awaiting state is for a different step — re-run Phase 1
              if (promptText) {
                outboundMsg = promptText;
                lastPreview = { type: "text", body: promptText };
                if (/^\d{10,15}$/.test(threadId)) {
                  const creds = await getCredentials(adminId);
                  if (creds) {
                    await sendTextMessage({
                      credentials: creds,
                      mobile: session.threadId,
                      message: promptText,
                    });
                    sentViaCpaas = true;
                  }
                }
              }
              session.waitingForInput = true;
              session.currentStepId = step.id;
              setAwaitingState(session, {
                stepId: step.id,
                type: "collect_input",
                promptText,
                validReplyIds: [],
                validReplyLabels: Array.isArray(step.validOptions) ? (step.validOptions as string[]) : [],
              });
              continueLoop = false;
              await logStepExit(executionLogId, "waiting", "waiting for input", session.currentStepId, 0);
              break;
            }
          }

          const rawInput = String(lastMessage ?? "").trim();
          const validOptions = Array.isArray(step.validOptions)
            ? (step.validOptions as string[])
            : [];
          const validationType = (step as any).validation ?? "text";

          // Check 1: validOptions whitelist (existing logic)
          const failsWhitelist =
            validOptions.length > 0 &&
            !validOptions.map((v: string) => v.toLowerCase()).includes(rawInput.toLowerCase());

          // Check 2: format validation (calls existing evaluateValidation)
          const failsValidation =
            validationType !== "text" &&
            !evaluateValidation(rawInput, validationType, step as any);

          if (failsWhitelist || failsValidation) {
            const stepQuestion = resolveTemplate(
              step.prompt ?? step.inputPrompt ?? "",
              data
            );

            // ── AI INTENT GUARD: collect_input ────────────────────────────────
            const offTopic = await isOffTopicMessage(
              rawInput,
              stepQuestion,
              validOptions,
              adminId,
              threadId
            );
            if (offTopic) {
              const wfContext = buildWorkflowContext(session, workflow, stepQuestion);
              await handleOffTopicReply(rawInput, stepQuestion, wfContext, adminId, threadId, session);
              session.lastActivityAt = new Date();
              await session.save();
              continueLoop = false;
              await logStepExit(executionLogId, "waiting", "off-topic handled by RAG", session.currentStepId, 0);
              break;
            }
            // ── END AI INTENT GUARD ───────────────────────────────────────────

            // Retry logic
            const retryKey = `__retries_${step.id}`;
            const retries =
              parseInt(session.collectedData.get(retryKey) ?? "0") + 1;
            session.collectedData.set(retryKey, String(retries));
            session.markModified("collectedData");

            const maxRetries = (step as any).maxRetries ?? 3;

            if (retries >= maxRetries) {
              if ((step as any).onMaxRetries) {
                session.currentStepId = (step as any).onMaxRetries;
                session.waitingForInput = false;
                await session.save();
                continueLoop = true;
                await logStepExit(
                  executionLogId,
                  "completed",
                  "max retries → onMaxRetries",
                  session.currentStepId,
                  retries
                );
                break;
              } else {
                session.done = true;
                session.waitingForInput = false;
                session.lastActivityAt = new Date();
                session.markModified("collectedData");
                await session.save();
                continueLoop = false;
                await logStepExit(
                  executionLogId,
                  "error",
                  "max retries exceeded",
                  session.currentStepId,
                  retries
                );
                break;
              }
            }

            // Under retry limit — build validation-aware retry message
            let retryMsg: string;
            if ((step as any).retryPrompt) {
              retryMsg = resolveTemplate((step as any).retryPrompt, data);
            } else if (failsValidation) {
              const typeLabels: Record<string, string> = {
                phone:  "a valid phone number (digits only, 10–15 digits)",
                email:  "a valid email address",
                date:   "a valid date",
                number: "a valid number",
                regex:  "a value matching the required format",
              };
              retryMsg = `Please enter ${typeLabels[validationType] ?? "a valid value"}.`;
            } else {
              retryMsg = stepQuestion;
            }

            outboundMsg = retryMsg;
            lastPreview = { type: "text", body: retryMsg };
            if (/^\d{10,15}$/.test(threadId)) {
              const creds = await getCredentials(adminId);
              if (creds) {
                await sendTextMessage({
                  credentials: creds,
                  mobile: session.threadId,
                  message: retryMsg,
                });
              }
            }
            session.waitingForInput = true;
            session.currentStepId = step.id;
            continueLoop = false;
            await session.save();
            await logStepExit(
              executionLogId,
              "waiting",
              `invalid — retry ${retries}/${maxRetries}`,
              session.currentStepId,
              retries
            );
            break;
          }

          clearAwaitingState(session);
          session.collectedData.set(varKey, rawInput);
          session.markModified("collectedData");
          session.waitingForInput = false;
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = true;
          await logStepExit(
            executionLogId,
            "completed",
            `collected: ${varKey}`,
            session.currentStepId,
            0
          );
          break;
        }

        // ── api_call ─────────────────────────────────────────────────────────
        case "api_call": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          let apiLogOutput = "";
          let apiErrorLogged = false;

          try {
            const cfg = step.apiConfig;
            if (!cfg?.url || !cfg?.method) {
              session.currentStepId = step.nextStep ?? "END";
              await logStepExit(executionLogId, "completed", "skipped: missing config", session.currentStepId, 0);
              break;
            }

            const resolvedUrl = resolveTemplate(cfg.url, data);
            apiLogOutput = `${cfg.method} ${resolvedUrl}`;

            const resolvedHeaders: Record<string, string> = {};
            for (const [k, v] of (cfg.headers ?? new Map()).entries()) {
              resolvedHeaders[k] = resolveTemplate(v, data);
            }

            const resolvedBody: Record<string, string> = {};
            for (const [k, v] of (cfg.body ?? new Map()).entries()) {
              resolvedBody[k] = resolveTemplate(v, data);
            }

            const response = await axios({
              method: cfg.method.toLowerCase() as "get" | "post" | "put" | "patch",
              url: resolvedUrl,
              headers: resolvedHeaders,
              data: cfg.method !== "GET" ? resolvedBody : undefined,
              params: cfg.method === "GET" ? resolvedBody : undefined,
            });

            for (const [varName, path] of (cfg.responseMapping ?? new Map()).entries()) {
              const resolved = resolvePath(response.data, path);
              session.collectedData.set(varName, resolved);
            }
            const mappings = Array.isArray((cfg as any).mappings)
              ? ((cfg as any).mappings as Array<{ variable?: string; path?: string }>)
              : [];
            for (const mapping of mappings) {
              if (!mapping?.variable || !mapping?.path) continue;
              const mappedValue = _.get(response.data, mapping.path);
              session.collectedData.set(
                mapping.variable,
                mappedValue == null
                  ? ""
                  : (typeof mappedValue === "string" ? mappedValue : JSON.stringify(mappedValue))
              );
            }
            const responseBody =
              typeof response.data === "string"
                ? response.data
                : JSON.stringify(response.data);
            if (step.saveResponseTo) {
              session.collectedData.set(step.saveResponseTo, responseBody);
            }
            session.markModified("collectedData");
          } catch (apiErr) {
            console.error(
              "[WorkflowEngine] api_call failed:",
              apiErr instanceof Error ? apiErr.message : apiErr
            );
            const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
            apiErrorLogged = true;
            if (step.apiConfig?.onError) {
              session.currentStepId = step.apiConfig.onError;
              await logStepExit(executionLogId, "error", apiLogOutput || "api_call", session.currentStepId, 0, errMsg);
              break;
            }
            await logStepExit(executionLogId, "error", apiLogOutput || "api_call", step.nextStep ?? "END", 0, errMsg);
          }
          session.currentStepId = step.nextStep ?? "END";
          if (!apiErrorLogged) {
            await logStepExit(executionLogId, "completed", apiLogOutput || "api_call", session.currentStepId, 0);
          }
          // continue loop — no outbound message from api_call
          break;
        }

        // ── send_template ─────────────────────────────────────────────────────
        case "send_template": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          let tmplLogName = step.templateConfig?.templateName ?? "";
          let tmplErrorLogged = false;

          try {
            const tc = step.templateConfig;
            if (!tc?.wid || !tc?.templateName) {
              session.currentStepId = step.nextStep ?? "END";
              await logStepExit(executionLogId, "completed", "skipped: missing config", session.currentStepId, 0);
              break;
            }
            tmplLogName = tc.templateName;

            const credentials = await AdminCredentials.findOne({ adminId });
            if (credentials) {
              const resolvedBodyParams: Record<string, string> = {};
              for (const [k, v] of (tc.bodyParams ?? new Map()).entries()) {
                resolvedBodyParams[k] = resolveTemplate(v, data);
              }

              await sendTemplate({
                user_id: credentials.user_id,
                token: credentials.token,
                mobile: threadId,
                wid: tc.wid,
                templateName: tc.templateName,
                bodyParams: resolvedBodyParams,
                headerParams: {},
                mediaUrl: resolveTemplate(tc.mediaUrl ?? "", data),
                brandNumber: credentials.brandNumber ?? "",
                createdByName: "AI Agent",
                createdById: credentials.user_id,
              });
              sentViaCpaas = true;
            }
          } catch (tmplErr) {
            console.error(
              "[WorkflowEngine] send_template failed:",
              tmplErr instanceof Error ? tmplErr.message : tmplErr
            );
            const errMsg = tmplErr instanceof Error ? tmplErr.message : String(tmplErr);
            tmplErrorLogged = true;
            if (step.templateConfig?.onError) {
              session.currentStepId = step.templateConfig.onError;
              await logStepExit(executionLogId, "error", `template: ${tmplLogName}`, session.currentStepId, 0, errMsg);
              break;
            }
            await logStepExit(executionLogId, "error", `template: ${tmplLogName}`, step.nextStep ?? "END", 0, errMsg);
          }
          session.currentStepId = step.nextStep ?? "END";
          if (!tmplErrorLogged) {
            await logStepExit(executionLogId, "completed", `template: ${tmplLogName}`, session.currentStepId, 0);
          }
          // continue loop — no outbound message
          break;
        }

        // ── delay ─────────────────────────────────────────────────────────────
        case "delay": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const minutes = step.delayMinutes ?? 1;
          session.delayUntil = new Date(Date.now() + minutes * 60 * 1000);
          session.markModified("delayUntil");
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = false; // scheduler will resume
          console.log("[Engine] delay set:", session.delayUntil);
          await logStepExit(executionLogId, "completed", `delay: ${minutes}min`, session.currentStepId, 0);
          break;
        }

        // ── condition ─────────────────────────────────────────────────────────
        case "condition": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const cond = step.condition;
          if (!cond) {
            session.currentStepId = step.nextStep ?? "END";
            await logStepExit(executionLogId, "completed", "default", session.currentStepId, 0);
            break;
          }

          const varKey = (cond.variable ?? "").replace(/\{\{|\}\}/g, "");
          const varValue = String(data[varKey] ?? "");
          let conditionOutput = "default";
          let nextStepId: string | undefined;

          // Multi-branch path: loop in order, first match wins
          if (cond.branches && cond.branches.length > 0) {
            let matched = false;

            if ((cond as any).fuzzy) {
              // AI classify path
              const labels = cond.branches
                .map((b: any) => b.label ?? "")
                .filter(Boolean);
              const matchedLabel = await classifyWithAI(
                varValue, labels, adminId, threadId
              );
              if (matchedLabel) {
                const branch = cond.branches.find(
                  (b: any) => (b.label ?? "").toLowerCase() === matchedLabel.toLowerCase()
                );
                if (branch) {
                  nextStepId = branch.nextStep ?? cond.defaultNextStep;
                  conditionOutput = `branch: ${matchedLabel}`;
                  matched = true;
                }
              }
            } else {
              // Exact match path (existing logic — do not change)
              for (const branch of cond.branches) {
                if (evaluateBranch(branch.operator, varValue, branch.value)) {
                  nextStepId = branch.nextStep ?? cond.defaultNextStep;
                  conditionOutput = `branch: ${branch.label ?? "matched"}`;
                  matched = true;
                  break;
                }
              }
            }

            if (!matched) {
              nextStepId = cond.defaultNextStep;
              conditionOutput = "default";
            }
          } else {
            // Legacy single-branch path (onTrue / onFalse)
            const result = evaluateBranch(cond.operator, varValue, cond.value);
            nextStepId = result ? cond.onTrue : cond.onFalse;
            conditionOutput = result ? "branch: true" : "branch: false";
          }

          // --- CONDITION FALLTHROUGH GUARD ---
          if (!nextStepId) {
            console.warn(
              `[WorkflowEngine] Condition step "${step.id}" in workflow "${workflow._id}" ` +
              `has no matching branch and no default path. ` +
              `Session ${session._id} terminated gracefully.`
            );

            const fallbackMsg =
              workflow.expiryMessage ||
              "Sorry, I couldn't process that. Please type a keyword to start again.";

            if (/^\d{10,15}$/.test(threadId)) {
              const creds = await getCredentials(adminId);
              if (creds) {
                await sendTextMessage({
                  credentials: creds,
                  mobile: session.threadId,
                  message: fallbackMsg,
                });
              }
            }

            session.done = true;
            session.waitingForInput = false;
            session.lastActivityAt = new Date();
            session.markModified("collectedData");
            await session.save();

            continueLoop = false;
            break;
          }
          // --- END CONDITION FALLTHROUGH GUARD ---

          session.currentStepId = nextStepId;

          // continue loop — condition step has no outbound message
          await logStepExit(executionLogId, "completed", conditionOutput, session.currentStepId, 0);
          break;
        }

        // ── send_menu ─────────────────────────────────────────────────────────
        case "send_menu": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const mc = step.menuConfig;
          if (!mc?.body) {
            session.currentStepId = step.nextStep ?? "END";
            await logStepExit(executionLogId, "completed", "skipped: missing body", session.currentStepId, 0);
            break;
          }

          let sections = mc.sections ?? [];

          if (mc.dynamicRowsKey) {
            const rawValue = String(data[mc.dynamicRowsKey] ?? "");
            if (rawValue) {
              sections = buildDynamicRows(rawValue, mc.sectionTitle ?? "Options");
            }
          }

          const menuBody = resolveTemplate(mc.body ?? "", data);
          const menuSections = sections.map((s: any) => ({
            title: resolveTemplate(String(s.title ?? ""), data),
            rows: (s.rows ?? []).map((r: any, rowIndex: number) => ({
              id: resolveTemplate(String(r.id ?? r.title ?? `row_${rowIndex}`), data),
              title: resolveTemplate(String(r.title ?? ""), data),
              description: resolveTemplate(String(r.description ?? ""), data),
            })),
          }));
          const buttonText = resolveTemplate(mc.buttonText ?? "Choose an option", data);

          const sendMenuCpaas = async () => {
            if (!/^\d{10,15}$/.test(threadId)) return;
            const creds = await getCredentials(adminId);
            if (!creds) return;
            try {
              await sendListMessage({
                credentials: creds,
                mobile: threadId,
                body: menuBody,
                buttonText,
                sections: menuSections,
              });
              sentViaCpaas = true;
            } catch (menuErr) {
              console.error(
                "[WorkflowEngine] send_menu failed:",
                menuErr instanceof Error ? menuErr.message : menuErr
              );
            }
          };

          if (!session.waitingForInput || session.currentStepId !== step.id) {
            outboundMsg = menuBody || null;
            lastPreview = {
              type: "list",
              body: menuBody,
              sections: menuSections,
            };
            await sendMenuCpaas();
            session.waitingForInput = true;
            session.currentStepId = step.id;
            {
              const validMenuIds = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.id || r.title || ""))
              );
              const validMenuLabels = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.title || r.description || r.id || ""))
              );
              setAwaitingState(session, {
                stepId: step.id,
                type: "send_menu",
                promptText: menuBody,
                validReplyIds: validMenuIds,
                validReplyLabels: validMenuLabels,
              });
            }
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
            break;
          }

          // ── V2 / legacy phase-2 gate ──────────────────────────────────────
          {
            let isV2Match = matchesAwaitingState(session, step, "send_menu");
            const isLegacyMatch = canUseLegacyAwaitingFallback(session, step);

            if (!isV2Match && isLegacyMatch) {
              // Self-heal: old/inconsistent session — repair V2 state without resending
              const validMenuIds = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.id || r.title || ""))
              );
              const validMenuLabels = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.title || r.description || r.id || ""))
              );
              repairAwaitingStateFromStep(session, step, {
                type: "send_menu",
                promptText: menuBody,
                validReplyIds: validMenuIds,
                validReplyLabels: validMenuLabels,
              });
              await session.save();
              isV2Match = true;
            }

            if (!isV2Match && !isLegacyMatch) {
              // V2 awaiting state is for a different step — re-run Phase 1
              outboundMsg = menuBody || null;
              lastPreview = {
                type: "list",
                body: menuBody,
                sections: menuSections,
              };
              await sendMenuCpaas();
              session.waitingForInput = true;
              session.currentStepId = step.id;
              const validMenuIds = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.id || r.title || ""))
              );
              const validMenuLabels = menuSections.flatMap((s: any) =>
                (s.rows ?? []).map((r: any) => String(r.title || r.description || r.id || ""))
              );
              setAwaitingState(session, {
                stepId: step.id,
                type: "send_menu",
                promptText: menuBody,
                validReplyIds: validMenuIds,
                validReplyLabels: validMenuLabels,
              });
              continueLoop = false;
              await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
              break;
            }
          }

          // --- STALE BUTTON DETECTION ---
          {
            // Only run stale detection when input does NOT match the current step's own rows.
            // This prevents false positives when multiple menus share the same row id
            // (e.g. every menu uses "row_1" for its first option).
            const rawInputCheck = String(lastMessage ?? "").trim().toLowerCase();
            const isCurrentStepInput = menuSections.some((s: any) =>
              (s.rows ?? []).some(
                (r: any) =>
                  String(r.id ?? "").toLowerCase() === rawInputCheck ||
                  String(r.title ?? "").toLowerCase().trim() === rawInputCheck
              )
            );

            if (!isCurrentStepInput) {
              const staleMatch = await detectStaleButtonReply(lastMessage, session, workflow);
              if (staleMatch) {
                console.log(
                  `[WorkflowEngine] Stale reply detected. Consuming selection immediately ` +
                  `for session ${session._id}, stale step "${staleMatch.staleStep.id}" ` +
                  `→ nextStep "${staleMatch.staleStep.nextStep ?? "END"}"`
                );

                // Remove internal keys that belong to steps after the stale step
                const retryKeysToRemove: string[] = [];
                session.collectedData.forEach((_: any, key: string) => {
                  if (
                    key.startsWith("__retries_") ||
                    key.startsWith("__menu_reply_") ||
                    key.startsWith("__loop_")
                  ) {
                    const keyStepId = key
                      .replace("__retries_", "")
                      .replace("__menu_reply_", "")
                      .replace(/_title$/, "")
                      .replace("__loop_", "")
                      .replace(/_count$/, "");
                    if (keyStepId !== staleMatch.staleStep.id) {
                      retryKeysToRemove.push(key);
                    }
                  }
                });
                retryKeysToRemove.forEach((k) => session.collectedData.delete(k));

                // Consume the stale selection immediately — no Phase 1 resend
                applyStaleSelectionToSession(session, staleMatch);
                session.lastActivityAt = new Date();
                session.expiresAt = new Date(
                  Date.now() + (workflow.timeoutMinutes || 30) * 60 * 1000
                );
                await session.save();

                continueLoop = true;
                continue;
              }
            }
          }
          // --- END STALE BUTTON DETECTION ---

          const rawInput = String(lastMessage ?? "").trim();
          const itemIds: string[] = [];
          const labelMap: Record<string, string> = {};
          for (const sec of menuSections) {
            for (const row of sec.rows || []) {
              const id = String(row.id || row.title || "");
              itemIds.push(id.toLowerCase());
              const label = String(row.title || row.description || id);
              labelMap[id.toLowerCase()] = label;
            }
          }

          // --- AI INTENT GUARD: send_menu ---
          {
            const menuQuestion = resolveTemplate(mc?.body ?? "", data);
            const menuTitles = menuSections
              .flatMap((s: any) => s.rows?.map((r: any) => r.title ?? "") ?? [])
              .filter(Boolean);

            const menuOffTopic = await isOffTopicMessage(
              rawInput,
              menuQuestion,
              menuTitles,
              adminId,
              threadId
            );

            if (menuOffTopic) {
              const wfContext = buildWorkflowContext(session, workflow, menuQuestion);
              await handleOffTopicReply(
                rawInput,
                menuQuestion,
                wfContext,
                adminId,
                threadId,
                session
              );
              session.lastActivityAt = new Date();
              await session.save();
              continueLoop = false;
              await logStepExit(
                executionLogId,
                "waiting",
                "off-topic handled by RAG",
                session.currentStepId,
                0
              );
              break;
            }
          }
          // --- END AI INTENT GUARD ---

          if (itemIds.length > 0 && !itemIds.includes(rawInput.toLowerCase())) {
            await sendMenuCpaas();
            outboundMsg = menuBody || null;
            lastPreview = {
              type: "list",
              body: menuBody,
              sections: menuSections,
            };
            session.waitingForInput = true;
            session.currentStepId = step.id;
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "invalid selection", session.currentStepId, 0);
            break;
          }

          const resolvedLabel = labelMap[rawInput.toLowerCase()] ?? rawInput;
          const autoReplyKey = `__menu_reply_${step.id}`;
          session.collectedData.set(autoReplyKey, rawInput);
          session.collectedData.set(`${autoReplyKey}_title`, resolvedLabel);
          if (step.saveResponseTo) {
            session.collectedData.set(step.saveResponseTo, resolvedLabel);
          }
          const replyStepId = session.awaitingStepId ?? step.id;
          resolvedInput = session.collectedData.get(`__menu_reply_${replyStepId}_title`) as string | undefined;
          session.markModified("collectedData");
          clearAwaitingState(session);
          session.waitingForInput = false;
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = true;
          await logStepExit(executionLogId, "completed", "menu selection", session.currentStepId, 0);
          break;
        }

        // ── loop ──────────────────────────────────────────────────────────────
        case "loop": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const lc = step.loopConfig;
          if (!lc?.targetStepId) {
            session.currentStepId = step.nextStep ?? "END";
            await logStepExit(executionLogId, "completed", "skipped: missing targetStepId", session.currentStepId, 0);
            break;
          }

          const countKey = `__loop_${step.id}_count`;
          const currentCount = parseInt(String(data[countKey] ?? "0"), 10);
          const maxIter = lc.maxIterations ?? 10;

          // Check exit condition first (if defined)
          let exitNow = currentCount >= maxIter;
          if (!exitNow && lc.exitCondition?.variable) {
            const exitVarKey = (lc.exitCondition.variable).replace(/\{\{|\}\}/g, "");
            const exitVarValue = String(data[exitVarKey] ?? "");
            if (evaluateBranch(lc.exitCondition.operator, exitVarValue, lc.exitCondition.value)) {
              exitNow = true;
            }
          }

          if (exitNow) {
            session.currentStepId = step.nextStep ?? "END";
          } else {
            session.collectedData.set(countKey, String(currentCount + 1));
            session.markModified("collectedData");
            session.currentStepId = lc.targetStepId;
          }
          // loop does NOT set continueLoop = false — continues executing
          await logStepExit(executionLogId, "completed", `iteration ${currentCount + 1}/${maxIter}`, session.currentStepId, 0);
          break;
        }

        // ── send_media ────────────────────────────────────────────────────────────
        case "send_media": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const mediaType = (step as any).mediaType ?? "image";
          const mediaUrl  = resolveTemplate((step as any).mediaUrl ?? "", data);
          const caption   = resolveTemplate((step as any).caption  ?? "", data);
          const filename  = (step as any).filename ?? "";

          // Map frontend mediaType → CPaaS messageType
          const messageType =
            mediaType === "video"    ? "VIDEO" :
            mediaType === "document" ? "file"  :
            "IMAGE";

          let mediaErrorLogged = false;

          try {
            if (!mediaUrl) {
              console.warn("[WorkflowEngine] send_media: no mediaUrl, skipping");
            } else if (/^\d{10,15}$/.test(threadId)) {
              const creds = await getCredentials(adminId);
              if (creds) {
                await sendMediaMessage({
                  credentials: creds,
                  mobile: session.threadId,
                  mediaUrl,
                  messageType,
                  caption: mediaType !== "document" ? caption : filename,
                });
                sentViaCpaas = true;
              }
            }
          } catch (mediaErr) {
            console.error(
              "[WorkflowEngine] send_media failed:",
              mediaErr instanceof Error ? mediaErr.message : mediaErr
            );
            const errMsg = mediaErr instanceof Error ? mediaErr.message : String(mediaErr);
            mediaErrorLogged = true;
            await logStepExit(
              executionLogId, "error",
              `send_media: ${mediaType} ${mediaUrl.slice(0, 40)}`,
              step.nextStep ?? "END", 0, errMsg
            );
          }

          outboundMsg = mediaUrl || null;
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = false;

          if (!mediaErrorLogged) {
            await logStepExit(
              executionLogId, "completed",
              `send_media: ${mediaType} ${mediaUrl.slice(0, 40)}`,
              session.currentStepId, 0
            );
          }
          break;
        }

        // ── assign_agent ─────────────────────────────────────────────────────────
        case "assign_agent": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          try {
            const creds = await getCredentials(adminId);
            const adminDoc = await AdminCredentials.findOne({ adminId });

            if (!creds || !adminDoc) {
              console.warn("[WorkflowEngine] assign_agent: missing credentials, skipping");
            } else {
              const agentType  = (step as any).agentType  ?? "agent";
              const agentValue = (step as any).agentValue ?? "";
              const agentEmail = (step as any).agentEmail ?? (adminDoc as any).email ?? "";

              await assignAgent({
                user_id: creds.userId,
                token:   creds.token,
                email:   agentEmail,
                mobile:  session.threadId,
                value:   agentValue,
                type:    agentType,
              });
            }
          } catch (agentErr) {
            console.error(
              "[WorkflowEngine] assign_agent failed:",
              agentErr instanceof Error ? agentErr.message : agentErr
            );
          }

          session.currentStepId = step.nextStep ?? "END";
          await logStepExit(executionLogId, "completed", "assign_agent", session.currentStepId, 0);
          break;
        }

        // ── assign_label ─────────────────────────────────────────────────────────
        case "assign_label": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          try {
            const creds = await getCredentials(adminId);

            if (!creds) {
              console.warn("[WorkflowEngine] assign_label: missing credentials, skipping");
            } else {
              const labelId = (step as any).labelId ?? "";

              await addLabel({
                user_id: creds.userId,
                token:   creds.token,
                mobile:  session.threadId,
                value:   labelId,
              });
            }
          } catch (labelErr) {
            console.error(
              "[WorkflowEngine] assign_label failed:",
              labelErr instanceof Error ? labelErr.message : labelErr
            );
          }

          session.currentStepId = step.nextStep ?? "END";
          await logStepExit(executionLogId, "completed", "assign_label", session.currentStepId, 0);
          break;
        }

        // ── ai_node ───────────────────────────────────────────────────────────
        case "ai_node": {
          await logStepEntry(executionLogId, step.id, step.type, lastMessage);

          const aiNodeStart = Date.now();
          let aiNodeReply = "";

          try {
            // 1. Load AdminConfig for KB settings
            const adminCfg = await AdminConfig.findOne({ adminId });
            const maxResults = adminCfg?.kb?.maxResults ?? 5;

            // 2. Resolve {{vars}} in the admin-authored prompt
            const resolvedPrompt = resolveTemplate((step as any).aiNodePrompt ?? "", data);

            // 3. RAG retrieval
            let kbContext = "";
            if (adminCfg) {
              const docs = await retrieve(lastMessage, adminId, maxResults);
              kbContext = Array.isArray(docs) ? docs.join("\n\n") : String(docs ?? "");
            }

            // 4. Build system prompt
            const systemPrompt = kbContext
              ? `${resolvedPrompt}\n\nKnowledge Base:\n${kbContext}`
              : resolvedPrompt;

            // 5. Call LLM
            const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
            const llm = new ChatGoogleGenerativeAI({
              model: "gemini-2.5-flash",
              temperature: 0,
              apiKey: process.env.GOOGLE_API_KEY,
            });

            const lastMsg = String(data["last_message"] ?? lastMessage);
            const llmResult = await llm.invoke([
              new SystemMessage(systemPrompt),
              new HumanMessage(lastMsg),
            ]);
            const latencyMs = Date.now() - aiNodeStart;

            // 6. Extract reply text (handle both string and array content)
            if (typeof llmResult.content === "string") {
              aiNodeReply = llmResult.content.trim();
            } else if (Array.isArray(llmResult.content)) {
              aiNodeReply = llmResult.content
                .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
                .join("")
                .trim();
            }

            // Fire-and-forget usage logging
            const usage =
              (llmResult as any).response_metadata?.usage ??
              (llmResult as any).usage_metadata ?? {};
            const inputTokens  = usage.input_tokens  ?? usage.prompt_tokens  ?? 0;
            const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
            const totalTokens  = usage.total_tokens  ?? (inputTokens + outputTokens);
            UsageLog.create({
              adminId,
              threadId,
              modelName: "gemini-2.5-flash",
              inputTokens,
              outputTokens,
              totalTokens,
              source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
              latencyMs,
              status: "success",
            }).catch((err) => console.error("[UsageLog] ai_node failed to save usage:", err));

          } catch (aiNodeErr) {
            const latencyMs = Date.now() - aiNodeStart;
            console.error(
              "[ai_node] LLM failed:",
              aiNodeErr instanceof Error ? aiNodeErr.message : aiNodeErr
            );
            UsageLog.create({
              adminId,
              threadId,
              modelName: "gemini-2.5-flash",
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
              latencyMs,
              status: "error",
            }).catch(() => {});
          }

          // 7. Store response if configured
          if ((step as any).storeResponseAs && aiNodeReply) {
            session.collectedData.set((step as any).storeResponseAs, aiNodeReply);
            session.markModified("collectedData");
          }

          // 8. Send to user via CPaaS (real phone threads only)
          if (aiNodeReply && /^\d{10,15}$/.test(threadId)) {
            const creds = await getCredentials(adminId);
            if (creds) {
              await sendTextMessage({
                credentials: creds,
                mobile: session.threadId,
                message: aiNodeReply,
              });
              sentViaCpaas = true;
            }
          }

          // 9. Advance session
          outboundMsg = aiNodeReply || null;
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = session.currentStepId !== "END";
          await logStepExit(executionLogId, "completed", `ai_node replied (${aiNodeReply.length} chars)`, session.currentStepId, 0);
          break;
        }

        default:
          session.currentStepId = step.nextStep ?? "END";
          break;
      }

      // Safety: if we ended up at END inside the loop
      if (session.currentStepId === "END") {
        session.done = true;
        continueLoop = false;
        break;
      }
    }

    // ── Execution log: session end ─────────────────────────────────────────
    try {
      if (executionLogId) {
        const finalStatus = session.done ? "completed" : "running";
        await ExecutionLog.findByIdAndUpdate(executionLogId, {
          $set: {
            status:      finalStatus,
            completedAt: session.done ? new Date() : null,
          },
        });
      }
    } catch (logErr) {
      console.error(
        "[ExecutionLog] session end update failed:",
        logErr instanceof Error ? logErr.message : logErr
      );
    }

    session.updatedAt = new Date();
    console.log("[Engine] saving session, delayUntil:", session.delayUntil);
    await session.save();

    return { text: outboundMsg ?? "", preview: lastPreview, resolvedInput };
  } catch (err) {
    console.error("[WorkflowEngine] error:", err instanceof Error ? err.message : err);
    return { text: "", preview: null };
  }
}
