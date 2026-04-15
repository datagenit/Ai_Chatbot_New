import axios from "axios";
import _ from "lodash";
import Workflow from "../models/Workflow.js";
import WorkflowSession from "../models/WorkflowSession.js";
import AdminCredentials from "../models/AdminCredentials.js";
import UsageLog from "../models/UsageLog.js";
import ExecutionLog from "../models/ExecutionLog.js";
import GlobalVariable from "../models/GlobalVariable.js";
import { sendTemplate, getCredentials, sendTextMessage, sendTextWithButtons, sendListMessage, sendMediaMessage, assignAgent, addLabel } from "../services/cpaas.js";

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

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runWorkflow(
  threadId: string,
  adminId: string,
  lastMessage: string
): Promise<{ text: string; preview: object | null }> {
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
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
            break;
          }

          const rawInput = String(lastMessage ?? "").trim();
          const buttonIds = buttons.map((b: { id: string }) => String(b.id).toLowerCase());
          const labelMap: Record<string, string> = {};
          buttons.forEach((b: { id: string; title: string }) => {
            const id = String(b.id || b.title);
            const label = String(b.title || b.id);
            labelMap[id.toLowerCase()] = label;
          });

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
          session.markModified("collectedData");
          session.waitingForInput = false;
          session.currentStepId = step.nextStep ?? "END";
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
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for input", session.currentStepId, 0);
            break;
          }

          const rawInput = String(lastMessage ?? "").trim();
          const validOptions = Array.isArray(step.validOptions)
            ? (step.validOptions as string[])
            : [];

          if (validOptions.length > 0) {
            const lowered = validOptions.map((v) => v.toLowerCase());
            if (!lowered.includes(rawInput.toLowerCase())) {
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
              continueLoop = false;
              await logStepExit(executionLogId, "waiting", "invalid selection", session.currentStepId, 0);
              break;
            }
          }

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
                  session.currentStepId = branch.nextStep ?? cond.defaultNextStep ?? "END";
                  conditionOutput = `branch: ${matchedLabel}`;
                  matched = true;
                }
              }
            } else {
              // Exact match path (existing logic — do not change)
              for (const branch of cond.branches) {
                if (evaluateBranch(branch.operator, varValue, branch.value)) {
                  session.currentStepId = branch.nextStep ?? cond.defaultNextStep ?? "END";
                  conditionOutput = `branch: ${branch.label ?? "matched"}`;
                  matched = true;
                  break;
                }
              }
            }

            if (!matched) {
              session.currentStepId = cond.defaultNextStep ?? "END";
              conditionOutput = "default";
            }
          } else {
            // Legacy single-branch path (onTrue / onFalse)
            const result = evaluateBranch(cond.operator, varValue, cond.value);
            session.currentStepId = result ? (cond.onTrue ?? "END") : (cond.onFalse ?? "END");
            conditionOutput = result ? "branch: true" : "branch: false";
          }

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
            continueLoop = false;
            await logStepExit(executionLogId, "waiting", "waiting for selection", session.currentStepId, 0);
            break;
          }

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
          session.markModified("collectedData");
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

    return { text: outboundMsg ?? "", preview: lastPreview };
  } catch (err) {
    console.error("[WorkflowEngine] error:", err instanceof Error ? err.message : err);
    return { text: "", preview: null };
  }
}
