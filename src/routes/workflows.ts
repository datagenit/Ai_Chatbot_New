import { Router, Response } from "express";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import Workflow from "../models/Workflow.js";
import WorkflowSession from "../models/WorkflowSession.js";
import ExecutionLog from "../models/ExecutionLog.js";
import { runWorkflow } from "../workflows/engine.js";
import type { AuthRequest } from "../middleware/auth.js";

function resolvePath(obj: unknown, path: string): string {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined && current !== null ? String(current) : "";
}

const router = Router();

// ── POST /webhook/:webhookPath — public, no auth ───────────────────────────────

router.post("/webhook/:webhookPath", async (req, res) => {
  try {
    const { webhookPath } = req.params;
    const payload = req.body;

    const workflows = await Workflow.find({
      "steps.type": "webhook",
      "steps.webhookConfig.path": webhookPath,
    });

    if (!workflows.length) {
      res.status(404).json({ success: false, error: "No workflow found for this webhook path" });
      return;
    }

    for (const workflow of workflows) {
      const webhookStep = workflow.steps.find(
        (s: any) => s.type === "webhook" && (s as any).webhookConfig?.path === webhookPath
      );
      if (!webhookStep) continue;

      const threadId: string = payload.mobile ?? payload.phone ?? `webhook_${webhookPath}`;
      const adminId = String((workflow as any).adminId ?? (workflow as any).admin_id ?? "");

      // Close any stuck active session for this thread
      await WorkflowSession.findOneAndUpdate(
        { threadId, done: false },
        { $set: { done: true } }
      );

      // Create session starting at the step AFTER the webhook step
      const session = await WorkflowSession.create({
        adminId,
        threadId,
        workflowId: workflow._id.toString(),
        currentStepId: (webhookStep as any).nextStep ?? "END",
        collectedData: new Map(),
        waitingForInput: false,
        done: false,
      });

      // Inject response mappings from webhook payload into session
      const mapping: Record<string, unknown> = (webhookStep as any).webhookConfig?.responseMapping ?? {};
      for (const [varName, path] of Object.entries(mapping)) {
        const value = resolvePath(payload, path as string);
        session.collectedData.set(varName, value);
      }
      session.markModified("collectedData");
      await session.save();

      await runWorkflow(threadId, adminId, "");
    }

    res.json({ success: true, message: "Webhook received and workflow triggered" });
  } catch (err) {
    console.error("[Webhook] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: "Webhook processing failed" });
  }
});

// ── POST /generate — AI-generate a workflow from plain English ─────────────────

router.post("/generate", async (req: AuthRequest, res: Response) => {
  try {
    const { description } = req.body as { description?: string };

    if (!description || typeof description !== "string" || description.trim().length < 50 || description.trim().length > 1000) {
      res.status(400).json({ error: "Description must be between 50 and 1000 characters" });
      return;
    }

    const model = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash",
      temperature: 0.2,
      apiKey: process.env.GOOGLE_API_KEY,
    });

    const systemPrompt = `You are a workflow builder assistant for a WhatsApp automation platform.
    Convert the user's plain English description into a valid workflow JSON object.
    
    STRICT RULES:
    - Return ONLY a raw JSON object. No markdown, no code blocks, no explanation.
    - steps[] must have sequential ids: "step_1", "step_2", "step_3" etc
    - entryStepId must always equal steps[0].id which is always "step_1"
    - Every step's nextStep must point to the next step's id, or "END" for the last step
    - Last step always has nextStep: "END"
    
    VALID STEP TYPES AND REQUIRED FIELDS:
    
    message:
      { id, type: "message", message: "string (use {{variable}} for collected data)", nextStep }
    
    send_interactive:
      {
        id,
        type: "send_interactive",
        nextStep,
        interactiveConfig: {
          message: "string — the message text to show above buttons",
          buttons: [
            { id: "btn_1", title: "Button label (max 20 chars)" },
            { id: "btn_2", title: "Button label (max 20 chars)" }
          ],
          nextStep: "same value as parent nextStep"
        }
      }
      Note: buttons array must have 1–3 items. Button id must be unique snake_case.
      The user's button click reply is received as the button id value.
      Use send_interactive when the user needs to pick from a fixed set of options.
    
      MANDATORY RULE — after EVERY send_interactive step, you MUST insert a
      collect_input step immediately after it (before any other logic step).
      This collect_input captures the button the user tapped as a named variable.
      Without it, the button choice is lost and cannot be referenced later.
    
      Correct pattern:
        step_N:   send_interactive → nextStep: "step_N+1"
        step_N+1: collect_input, inputKey: "descriptive_key_name",
                  inputPrompt: "Got it! Let me help you with that.",
                  validation: "text", nextStep: "step_N+2"
        step_N+2: next logic — can now use {{descriptive_key_name}}
    
      The collect_input after send_interactive does NOT need to ask a real question.
      Its inputPrompt is just a short acknowledgement like "Got it!" or "Sure!".
      The button tap reply is automatically stored as the inputKey value.
      Never skip this collect_input — it is always required after send_interactive.
    
    collect_input:
      { id, type: "collect_input", inputKey: "snake_case_name", inputPrompt: "question to ask user", validation: "text"|"phone"|"date"|"email", nextStep }
      - inputPrompt is the question shown to the user to collect this specific value
      - inputKey is the variable name that stores the user's answer
      - The prompt and key must match: prompt asks for what key stores
      - Example: inputPrompt "What is your name?" → inputKey "user_name"
      - Example: inputPrompt "What is your email?" → inputKey "user_email"
    
    api_call:
      { id, type: "api_call", apiConfig: { url: "string", method: "GET"|"POST"|"PUT"|"PATCH", headers: {}, body: { "fieldName": "{{variable}}" }, responseMapping: { "variableName": "dot.path.in.response" } }, nextStep }
    
    send_template:
      { id, type: "send_template", templateConfig: { wid: 0, templateName: "", bodyParams: { "1": "{{variable}}" }, mediaUrl: "" }, nextStep }
    
    delay:
      { id, type: "delay", delayMinutes: 30, nextStep }
    
    condition:
      { id, type: "condition", condition: { variable: "{{variable}}", operator: "equals"|"contains"|"exists", value: "string", onTrue: "step_id or END", onFalse: "step_id or END" } }
      Note: condition steps do NOT have nextStep — routing is via onTrue/onFalse only
      send_interactive steps have nextStep on the parent step AND inside interactiveConfig — both must be the same value
    
    TRIGGER:
      trigger: { type: "keyword", keywords: ["extracted", "from", "description"] }
    
    OUTPUT FORMAT — return exactly this shape:
    {
      "name": "descriptive workflow name",
      "trigger": { "type": "keyword", "keywords": ["keyword1", "keyword2"] },
      "entryStepId": "step_1",
      "steps": [ ...steps ]
    }
    
    VARIABLE USAGE:
    - Variables collected via collect_input are referenced as {{inputKey}} in later steps
    - Variables are available in all steps AFTER the collect_input step that defines them
    - Available built-in variables: {{user_name}}, {{user_phone}}, {{user_email}}
    - NEVER use {{last_message}} in any step — it is internal only and must not appear in prompts or messages
    - API response variables are available after api_call via responseMapping keys
    
    VARIABLE NAMING RULES:
    - inputKey must be snake_case and descriptive of what is being collected
    - Never reuse the same inputKey across multiple collect_input steps
    - Button choice keys should reflect the choice context e.g. "support_category", "selected_plan"
    
    IMPORTANT:
    - For collect_input steps, make the inputPrompt conversational and friendly
    - Extract 2-5 relevant trigger keywords from the description
    - If the description mentions an API URL, use it exactly as given
    - If no API URL is given but an API call is implied, use "https://api.example.com/endpoint" as placeholder
    - If condition step is used, onTrue and onFalse must point to valid step ids or "END"
    - Generate a clear descriptive name for the workflow based on the description
    - Always number steps sequentially with no gaps — step_1, step_2, step_3...
    - Re-number all steps after inserting mandatory collect_input steps after send_interactive`;

    const response = await model.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: description.trim() },
    ]);

    const raw = typeof response.content === "string" ? response.content : String(response.content);
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      res.status(422).json({ error: "AI could not generate a valid workflow. Please try a more detailed description." });
      return;
    }

    const steps = parsed.steps as Array<Record<string, unknown>> | undefined;
    const trigger = parsed.trigger as Record<string, unknown> | undefined;
    const isValid =
      typeof parsed.name === "string" &&
      Array.isArray(trigger?.keywords) &&
      (trigger.keywords as unknown[]).length > 0 &&
      Array.isArray(steps) &&
      steps.length > 0 &&
      typeof parsed.entryStepId === "string" &&
      parsed.entryStepId === steps[0]?.id;

    if (!isValid) {
      res.status(422).json({ error: "AI returned an incomplete workflow. Please try again with more detail." });
      return;
    }

    res.json({
      success: true,
      workflow: parsed,
      message: "Workflow generated. Please review all steps before saving.",
    });
  } catch (err) {
    console.error("POST /workflows/generate error:", err);
    res.status(500).json({ error: "Failed to generate workflow. Please try again." });
  }
});

// ── POST / — create workflow ───────────────────────────────────────────────────

router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, trigger, entryStepId, steps, enabled } = req.body as {
      name?: string;
      description?: string;
      trigger?: { type?: string; keywords?: string[] };
      entryStepId?: string;
      steps?: Array<Record<string, unknown>>;
      enabled?: boolean;
    };

    // ── Basic validation ─────────────────────────────────────────────────────
    if (!name) {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }
    if (!trigger?.type) {
      res.status(400).json({ success: false, error: "trigger.type is required" });
      return;
    }
    if (!entryStepId) {
      res.status(400).json({ success: false, error: "entryStepId is required" });
      return;
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ success: false, error: "steps must be a non-empty array" });
      return;
    }

    // ── Step id uniqueness ───────────────────────────────────────────────────
    const stepIds = steps.map((s) => s.id as string);
    const uniqueIds = new Set(stepIds);
    if (uniqueIds.size !== stepIds.length) {
      res.status(400).json({ success: false, error: "All step ids must be unique" });
      return;
    }

    // ── entryStepId must exist in steps ──────────────────────────────────────
    if (!uniqueIds.has(entryStepId)) {
      res.status(400).json({ success: false, error: "entryStepId must refer to an existing step id" });
      return;
    }

    // ── Per-type step validation ─────────────────────────────────────────────
    for (const step of steps) {
      const type = step.type as string;
      switch (type) {
        case "collect_input":
          if (!step.inputKey || !step.inputPrompt) {
            res.status(400).json({ success: false, error: `Step "${step.id}": inputKey and inputPrompt are required for collect_input` });
            return;
          }
          break;
        case "api_call": {
          const cfg = step.apiConfig as Record<string, unknown> | undefined;
          if (!cfg?.url || !cfg?.method) {
            res.status(400).json({ success: false, error: `Step "${step.id}": apiConfig.url and apiConfig.method are required for api_call` });
            return;
          }
          break;
        }
        case "send_template": {
          const tc = step.templateConfig as Record<string, unknown> | undefined;
          if (!tc?.wid || !tc?.templateName) {
            res.status(400).json({ success: false, error: `Step "${step.id}": templateConfig.wid and templateConfig.templateName are required for send_template` });
            return;
          }
          break;
        }
        case "delay":
          if (!step.delayMinutes || (step.delayMinutes as number) <= 0) {
            res.status(400).json({ success: false, error: `Step "${step.id}": delayMinutes is required and must be > 0 for delay` });
            return;
          }
          break;
        case "condition": {
          const cond = step.condition as Record<string, unknown> | undefined;
          if (!cond?.variable || !cond?.operator || !cond?.onTrue || !cond?.onFalse) {
            res.status(400).json({ success: false, error: `Step "${step.id}": condition.variable, operator, onTrue, onFalse are all required` });
            return;
          }
          break;
        }
      }
    }

    const workflow = await Workflow.create({
      adminId: req.adminId,
      name,
      description,
      trigger,
      entryStepId,
      steps,
      enabled: enabled ?? true,
    });

    res.status(201).json({ success: true, data: workflow });
  } catch (err) {
    console.error("POST /workflows error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to create workflow",
    });
  }
});

// ── GET / — list all workflows ────────────────────────────────────────────────

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const workflows = await Workflow.find({ adminId: req.adminId })
      .select("-__v")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: workflows });
  } catch (err) {
    console.error("GET /workflows error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch workflows",
    });
  }
});

// ── GET /runs/:runId — get single execution log (MUST be before /:id) ─────────

router.get("/runs/:runId", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const { runId } = req.params;

    const log = await ExecutionLog.findOne({ _id: runId, adminId });

    if (!log) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json(log);
  } catch (err) {
    console.error("GET /workflows/runs/:runId error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to fetch runs" });
  }
});

// ── GET /:workflowId/runs — paginated execution log list ──────────────────────

router.get("/:workflowId/runs", async (req: AuthRequest, res: Response) => {
  try {
    const adminId    = req.adminId;
    const { workflowId } = req.params;
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip  = (page - 1) * limit;

    const [runs, total] = await Promise.all([
      ExecutionLog.find({ adminId, workflowId })
        .select("-steps")
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit),
      ExecutionLog.countDocuments({ adminId, workflowId }),
    ]);

    res.json({
      runs,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("GET /workflows/:workflowId/runs error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to fetch runs" });
  }
});

// ── GET /:id — get single workflow ────────────────────────────────────────────

router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const workflow = await Workflow.findOne({
      _id: req.params.id,
      adminId: req.adminId,
    }).select("-__v");

    if (!workflow) {
      res.status(404).json({ success: false, error: "Workflow not found" });
      return;
    }

    res.json({ success: true, data: workflow });
  } catch (err) {
    console.error("GET /workflows/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch workflow",
    });
  }
});

// ── PATCH /:id — update workflow ──────────────────────────────────────────────

router.patch("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, enabled, trigger, steps, entryStepId } = req.body as {
      name?: string;
      description?: string;
      enabled?: boolean;
      trigger?: Record<string, unknown>;
      steps?: Array<Record<string, unknown>>;
      entryStepId?: string;
    };

    const setPayload: Record<string, unknown> = {};
    if (name !== undefined)        setPayload.name        = name;
    if (description !== undefined) setPayload.description = description;
    if (enabled !== undefined)     setPayload.enabled     = enabled;
    if (trigger !== undefined)     setPayload.trigger     = trigger;
    if (steps !== undefined)       setPayload.steps       = steps;
    if (entryStepId !== undefined) setPayload.entryStepId = entryStepId;

    const workflow = await Workflow.findOneAndUpdate(
      { _id: req.params.id, adminId: req.adminId },
      { $set: setPayload },
      { new: true }
    ).select("-__v");

    if (!workflow) {
      res.status(404).json({ success: false, error: "Workflow not found" });
      return;
    }

    res.json({ success: true, data: workflow });
  } catch (err) {
    console.error("PATCH /workflows/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update workflow",
    });
  }
});

// ── DELETE /:id — delete workflow + sessions ──────────────────────────────────

router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const workflow = await Workflow.findOneAndDelete({
      _id: req.params.id,
      adminId: req.adminId,
    });

    if (!workflow) {
      res.status(404).json({ success: false, error: "Workflow not found" });
      return;
    }

    await WorkflowSession.deleteMany({ workflowId: req.params.id });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /workflows/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete workflow",
    });
  }
});

// ── PATCH /:id/toggle — flip enabled ─────────────────────────────────────────

router.patch("/:id/toggle", async (req: AuthRequest, res: Response) => {
  try {
    const workflow = await Workflow.findOne({ _id: req.params.id, adminId: req.adminId });

    if (!workflow) {
      res.status(404).json({ success: false, error: "Workflow not found" });
      return;
    }

    workflow.enabled = !workflow.enabled;
    await workflow.save();

    res.json({ success: true, data: { id: workflow._id, enabled: workflow.enabled } });
  } catch (err) {
    console.error("PATCH /workflows/:id/toggle error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to toggle workflow",
    });
  }
});

// ── GET /:id/sessions — list sessions for a workflow ─────────────────────────

router.get("/:id/sessions", async (req: AuthRequest, res: Response) => {
  try {
    const workflow = await Workflow.findOne({ _id: req.params.id, adminId: req.adminId });

    if (!workflow) {
      res.status(404).json({ success: false, error: "Workflow not found" });
      return;
    }

    const sessions = await WorkflowSession.find({ workflowId: req.params.id })
      .select("-collectedData")
      .sort({ startedAt: -1 });

    res.json({ success: true, data: sessions });
  } catch (err) {
    console.error("GET /workflows/:id/sessions error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch sessions",
    });
  }
});

export default router;
