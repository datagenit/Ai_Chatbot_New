import { Router } from "express";
import { runAgent } from "../agent/index.js";
import { AIMessage } from "@langchain/core/messages";
import adminRoutes from "./admin.js";
import automationsRouter from "./automations.js";
import workflowRoutes from "./workflows.js";
import globalVariablesRouter from "./globalVariables.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { runAutomations } from "../automations/engine.js";
import UsageLog from "../models/UsageLog.js";
import WorkflowSession from "../models/WorkflowSession.js";
import Workflow from "../models/Workflow.js";
import { runWorkflow } from "../workflows/engine.js";
import { matchWorkflowTrigger } from "../workflows/triggerMatcher.js";
import { isThreadDelayed } from "../workflows/delayScheduler.js";
import { apiLimiter, chatLimiter, credentialsLimiter } from "../middleware/rateLimiter.js";
import { sanitizeInput } from "../middleware/sanitize.js";

const router = Router();

router.use(sanitizeInput);
router.use(apiLimiter);

router.use("/automations/credentials", credentialsLimiter);

router.post("/chat", chatLimiter, authMiddleware, async (req: AuthRequest, res) => {
  const requestStart = Date.now();
  try {
    const { message, threadId } = req.body as {
      message?: string;
      threadId?: string;
    };

    if (!threadId) {
      res.status(400).json({ success: false, error: "threadId is required" });
      return;
    }

    const adminId = req.adminId!;
    const input = message ?? "Hello";
    console.log('[Chat] input:', input, '| threadId:', threadId);
    // ── 1. Delay check — if thread is in a workflow delay, do nothing ─────────
    const delayed = await isThreadDelayed(threadId);
    if (delayed) {
      res.status(200).json({ success: true, response: "", threadId });
      return;
    }

    // ── 2. Active workflow session ─────────────────────────────────────────────
    const activeSession = await WorkflowSession.findOne({ threadId, done: false });
    console.log('[Chat] activeSession:', !!activeSession, activeSession ? `stepId: ${activeSession.currentStepId} | waiting: ${activeSession.waitingForInput}` : '');
    if (activeSession) {
      try {
        const wfResponse = await runWorkflow(threadId, adminId, input);
        console.log('[Chat] wfResponse:', wfResponse);
        res.json({ success: true, response: wfResponse ?? "", threadId });
        return;
      } catch (wfErr) {
        console.error("[Workflow] engine error, falling through to agent:", wfErr);
        await WorkflowSession.findOneAndUpdate({ threadId }, { $set: { done: true } });
        // do NOT return — fall through to step 5
      }
    }

    // ── 3. Workflow trigger matching ───────────────────────────────────────────
    const triggerMatch = await matchWorkflowTrigger(adminId, input);
    console.log('[Chat] triggerMatch:', !!triggerMatch);
    if (triggerMatch) {
      const workflow = await Workflow.findById(triggerMatch.workflowId);
      if (workflow) {
        try {
          // Close any stuck active session for this thread
          await WorkflowSession.findOneAndUpdate(
            { threadId, done: false },
            { $set: { done: true } }
          );

          // Always create a fresh session for the new trigger
          await WorkflowSession.create({
            adminId,
            threadId,
            workflowId: triggerMatch.workflowId,
            currentStepId: workflow.entryStepId,
            collectedData: new Map(),
            waitingForInput: false,
            done: false,
          });
          const wfResponse = await runWorkflow(threadId, adminId, input);
          res.json({ success: true, response: wfResponse ?? "", threadId });
          return;
        } catch (wfErr) {
          console.error("[Workflow] engine error, falling through to agent:", wfErr);
          // do NOT return — fall through to step 5
        }
      }
    }

    // ── 4. Automation rules ────────────────────────────────────────────────────
    // Run automations before the agent (threadId == mobile number)
    const automationResult = await runAutomations(adminId, input, threadId);
    if (automationResult.matched) {
      res.json({ success: true, response: "", threadId });
      return;
    }

    // ── 5. AI agent (fallthrough) ──────────────────────────────────────────────
    const result = await runAgent(adminId, input, threadId);

    // Extract the final AI response text from the result messages
    const messages = result.messages ?? [];
    let finalContent = "";

    for (let i = messages.length - 1; i >= 0; i -= 1) {
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

      if (typeof (msg as any).content === "string") {
        const text = (msg as any).content.trim();
        if (text.length > 0) {
          finalContent = text;
          break;
        }
      }
    }

    res.json({ success: true, response: finalContent, threadId });
  } catch (err) {
    console.error(err);
    const { message: _msg, threadId: _tid } = req.body as {
      message?: string;
      threadId?: string;
    };
    if (_tid) {
      UsageLog.create({
        adminId: req.adminId!,
        threadId: _tid,
        modelName: "llama-3.3-70b-versatile",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: _tid.startsWith("admin-test") ? "test" : "whatsapp",
        latencyMs: Date.now() - requestStart,
        status: "error",
      }).catch(() => { });
    }
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Agent request failed",
    });
  }
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Admin management routes
router.use("/admin", authMiddleware, adminRoutes);

// Public — internal pipeline use only, no auth
router.get("/automations/trigger-templates/active/:adminId", (req, res, next) => {
  req.url = req.url.replace(/^\/automations/, "") || "/";
  automationsRouter(req, res, next);
});

// Automations routes (auth applied at mount level)
router.use("/automations", authMiddleware, automationsRouter);

// Workflow routes
router.use("/workflows", authMiddleware, workflowRoutes);

// Global variables routes
router.use("/globals", authMiddleware, globalVariablesRouter);

export default router;
