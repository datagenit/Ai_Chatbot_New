import { Router } from "express";
import { runAgent } from "../agent/index.js";
import { AIMessage } from "@langchain/core/messages";
import adminRoutes from "./admin.js";
import automationsRouter from "./automations.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { runAutomations } from "../automations/engine.js";
import UsageLog from "../models/UsageLog.js";

const router = Router();

router.post("/chat", authMiddleware, async (req: AuthRequest, res) => {
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

    // Run automations before the agent (threadId == mobile number)
    await runAutomations(adminId, input, threadId);

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
      }).catch(() => {});
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

// Automations routes (auth applied at mount level)
router.use("/automations", authMiddleware, automationsRouter);

export default router;
