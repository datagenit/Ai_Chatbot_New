import { Router } from "express";
import { createAgent } from "../agents/agent.js";
import { env } from "../config/env.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import adminRoutes from "./admin.js";

const router = Router();
const agent = createAgent(env.GROQ_API_KEY);

router.post("/chat", async (req, res) => {
  try {
    const { message, adminId } = req.body as {
      message?: string;
      adminId?: string;
    };
    const input = message ?? "Hello";

    const result = await agent.invoke({
      messages: [new HumanMessage(input)],
      adminId,
    });

    // TEMP: log full message history for debugging
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result.messages, null, 2));

    const messages = result.messages ?? [];
    let finalContent = "";

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];

      // Only consider AI messages / assistant responses
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

      // Skip intermediate tool call messages
      if (hasToolCalls) continue;

      if (typeof (msg as any).content === "string") {
        const text = (msg as any).content.trim();
        if (text.length > 0) {
          finalContent = text;
          break;
        }
      }
    }

    res.json({ response: finalContent });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Agent request failed",
    });
  }
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Register admin routes
router.use("/admin", adminRoutes);

export default router;
