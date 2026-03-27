import axios from "axios";
import Workflow from "../models/Workflow.js";
import WorkflowSession from "../models/WorkflowSession.js";
import AdminCredentials from "../models/AdminCredentials.js";
import { sendTemplate, getCredentials, sendTextMessage, sendTextWithButtons } from "../services/cpaas.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function interpolate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => data[key] ?? `{{${key}}}`);
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

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runWorkflow(
  threadId: string,
  adminId: string,
  lastMessage: string
): Promise<string | null> {
  try {
    const session = await WorkflowSession.findOne({ threadId, done: false });
    if (!session) return null;

    if (session.currentStepId === "END") {
      session.done = true;
      await session.save();
      return null;
    }

    const workflow = await Workflow.findById(session.workflowId);
    if (!workflow) {
      session.done = true;
      await session.save();
      return null;
    }

    let outboundMsg: string | null = null;
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

      const data: Record<string, string> = {
        ...Object.fromEntries(session.collectedData ?? new Map()),
        last_message: lastMessage,
      };

      switch (step.type) {
        // ── message ─────────────────────────────────────────────────────────
        case "message": {
          const messageText = interpolate(step.message ?? "", data);
          outboundMsg = messageText;

          if (/^\d{10,15}$/.test(threadId)) {
            const creds = await getCredentials(adminId);
            if (creds) {
              await sendTextMessage({
                credentials: creds,
                mobile: session.threadId,
                message: messageText,
              });
            }
          }

          session.currentStepId = step.nextStep ?? "END";
          continueLoop = false;
          break;
        }

        // ── send_interactive ──────────────────────────────────────────────────
        case "send_interactive": {
          const ic = (step as any).interactiveConfig;
          const messageText = ic?.message ?? "";
          outboundMsg = messageText;

          if (/^\d{10,15}$/.test(threadId)) {
            const creds = await getCredentials(adminId);
            if (creds) {
              await sendTextWithButtons({
                credentials: creds,
                mobile: session.threadId,
                message: messageText,
                buttons: ic?.buttons ?? [],
              });
            }
          }

          session.currentStepId = ic?.nextStep ?? "END";
          session.waitingForInput = false;
          continueLoop = false;
          break;
        }

        // ── collect_input ────────────────────────────────────────────────────
        case "collect_input": {
          if (!session.waitingForInput) {
            outboundMsg = interpolate(step.inputPrompt ?? "", data);
            session.waitingForInput = true;
            continueLoop = false;
          } else {
            session.collectedData.set(step.inputKey ?? "input", lastMessage);
            session.markModified('collectedData');
            session.waitingForInput = false;
            session.currentStepId = step.nextStep ?? "END";
            // continue loop — next step will self-regulate via its own continueLoop logic
          }
          break;
        }

        // ── api_call ─────────────────────────────────────────────────────────
        case "api_call": {
          try {
            const cfg = step.apiConfig;
            if (!cfg?.url || !cfg?.method) {
              session.currentStepId = step.nextStep ?? "END";
              break;
            }

            const resolvedUrl = interpolate(cfg.url, data);

            const resolvedHeaders: Record<string, string> = {};
            for (const [k, v] of (cfg.headers ?? new Map()).entries()) {
              resolvedHeaders[k] = interpolate(v, data);
            }

            const resolvedBody: Record<string, string> = {};
            for (const [k, v] of (cfg.body ?? new Map()).entries()) {
              resolvedBody[k] = interpolate(v, data);
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
            session.markModified('collectedData');
          } catch (apiErr) {
            console.error(
              "[WorkflowEngine] api_call failed:",
              apiErr instanceof Error ? apiErr.message : apiErr
            );
          }
          session.currentStepId = step.nextStep ?? "END";
          // continue loop — no outbound message from api_call
          break;
        }

        // ── send_template ─────────────────────────────────────────────────────
        case "send_template": {
          try {
            const tc = step.templateConfig;
            if (!tc?.wid || !tc?.templateName) {
              session.currentStepId = step.nextStep ?? "END";
              break;
            }

            const credentials = await AdminCredentials.findOne({ adminId });
            if (credentials) {
              const resolvedBodyParams: Record<string, string> = {};
              for (const [k, v] of (tc.bodyParams ?? new Map()).entries()) {
                resolvedBodyParams[k] = interpolate(v, data);
              }

              await sendTemplate({
                user_id: credentials.user_id,
                token: credentials.token,
                mobile: threadId,
                wid: tc.wid,
                templateName: tc.templateName,
                bodyParams: resolvedBodyParams,
                headerParams: {},
                mediaUrl: interpolate(tc.mediaUrl ?? "", data),
                brandNumber: credentials.brandNumber ?? "",
                createdByName: "AI Agent",
                createdById: credentials.user_id,
              });
            }
          } catch (tmplErr) {
            console.error(
              "[WorkflowEngine] send_template failed:",
              tmplErr instanceof Error ? tmplErr.message : tmplErr
            );
          }
          session.currentStepId = step.nextStep ?? "END";
          // continue loop — no outbound message
          break;
        }

        // ── delay ─────────────────────────────────────────────────────────────
        case "delay": {
          const minutes = step.delayMinutes ?? 1;
          session.delayUntil = new Date(Date.now() + minutes * 60 * 1000);
          session.markModified('delayUntil');
          session.currentStepId = step.nextStep ?? "END";
          continueLoop = false; // scheduler will resume
          console.log('[Engine] delay set:', session.delayUntil);
          break;
        }

        // ── condition ─────────────────────────────────────────────────────────
        case "condition": {
          const cond = step.condition;
          if (!cond) {
            session.currentStepId = step.nextStep ?? "END";
            break;
          }

          const varValue = data[cond.variable?.replace(/\{\{|\}\}/g, "") ?? ""] ?? "";
          let result = false;

          switch (cond.operator) {
            case "equals":
              result = varValue === (cond.value ?? "");
              break;
            case "contains":
              result = varValue.includes(cond.value ?? "");
              break;
            case "exists":
              result = varValue.length > 0;
              break;
          }

          session.currentStepId = result ? (cond.onTrue ?? "END") : (cond.onFalse ?? "END");
          // continue loop — condition step has no outbound message
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

    session.updatedAt = new Date();
    console.log('[Engine] saving session, delayUntil:', session.delayUntil);
    await session.save();

    return outboundMsg;
  } catch (err) {
    console.error("[WorkflowEngine] error:", err instanceof Error ? err.message : err);
    return null;
  }
}
