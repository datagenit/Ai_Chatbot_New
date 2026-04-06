import { Router, Request, Response } from "express";
import AutomationRule from "../models/AutomationRule.js";
import AdminCredentials from "../models/AdminCredentials.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();



// ── Credentials ───────────────────────────────────────────────────────────────

// POST /api/automations/credentials — save CPaaS credentials
router.post("/credentials", async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, token, email, brandNumber } = req.body as {
      user_id?: number;
      token?: string;
      email?: string;
      brandNumber?: string;
    };

    if (!user_id || !token || !email) {
      res.status(400).json({
        success: false,
        error: "user_id, token, and email are required",
      });
      return;
    }

    const adminId = req.adminId;

    const creds = await AdminCredentials.findOneAndUpdate(
      { adminId },
      {
        $set: {
          user_id: Number(user_id),
          token,
          email,
          brandNumber: brandNumber ?? "",
        },
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, data: creds });
  } catch (err) {
    console.error("POST /automations/credentials error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to save credentials",
    });
  }
});

// GET /api/automations/credentials — get credentials (no token field)
router.get("/credentials", async (req: AuthRequest, res: Response) => {
  try {
    const credentials = await AdminCredentials.findOne(
      { adminId: req.adminId },
      { token: 0 }   // exclude token from projection
    );

    res.status(200).json({ success: true, data: credentials });
  } catch (err) {
    console.error("GET /automations/credentials error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch credentials",
    });
  }
});
// ── Rules CRUD ────────────────────────────────────────────────────────────────
// GET /api/automations — list all rules for this admin
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const rules = await AutomationRule.find({ adminId: req.adminId }).sort({
      createdAt: 1,
    });
    res.json({ success: true, data: rules });
  } catch (err) {
    console.error("GET /automations error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch automation rules",
    });
  }
});

// POST /api/automations — create a new rule
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { name, enabled, trigger, action } = req.body as {
      name?: string;
      enabled?: boolean;
      trigger?: {
        type: "keyword" | "sentiment";
        keywords?: string[];
        sentiment?: "positive" | "negative" | "neutral";
      };
      action?: {
        type: "assign_agent" | "assign_label";
        value: string;
      };
    };

    if (!name || !trigger || !action) {
      res.status(400).json({
        success: false,
        error: "name, trigger, and action are required",
      });
      return;
    }

    const rule = await AutomationRule.create({
      adminId: req.adminId,
      name,
      enabled: enabled ?? true,
      trigger,
      action,
    });

    res.status(201).json({ success: true, data: rule });
  } catch (err) {
    console.error("POST /automations error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to create automation rule",
    });
  }
});

// PATCH /api/automations/:id — update a rule (must belong to this admin)
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { name, enabled, trigger, action } = req.body as Partial<{
      name: string;
      enabled: boolean;
      trigger: {
        type: "keyword" | "sentiment";
        keywords?: string[];
        sentiment?: "positive" | "negative" | "neutral";
      };
      action: {
        type: "assign_agent" | "assign_label";
        value: string;
      };
    }>;

    const rule = await AutomationRule.findOneAndUpdate(
      { _id: req.params.id, adminId: req.adminId },
      { $set: { name, enabled, trigger, action } },
      { returnDocument: 'after', omitUndefined: true }
    );

    if (!rule) {
      res.status(404).json({
        success: false,
        error: "Automation rule not found",
      });
      return;
    }

    res.json({ success: true, data: rule });
  } catch (err) {
    console.error("PATCH /automations/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update automation rule",
    });
  }
});

// DELETE /api/automations/:id — delete a rule (must belong to this admin)
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const rule = await AutomationRule.findOneAndDelete({
      _id: req.params.id,
      adminId: req.adminId,
    });

    if (!rule) {
      res.status(404).json({
        success: false,
        error: "Automation rule not found",
      });
      return;
    }

    res.json({ success: true, message: "Automation rule deleted" });
  } catch (err) {
    console.error("DELETE /automations/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete automation rule",
    });
  }
});



// ── Trigger Templates ─────────────────────────────────────────────────────────

// POST /api/automations/trigger-templates — create a trigger template
router.post("/trigger-templates", async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      enabled,
      triggerType,
      keywords,
      confidenceThreshold,
      stage,
      waitMinutes,
      cooldownHours,
      template,
    } = req.body as {
      name?: string;
      enabled?: boolean;
      triggerType?: string;
      keywords?: string[];
      confidenceThreshold?: number;
      stage?: string;
      waitMinutes?: number;
      cooldownHours?: number;
      template?: {
        wid?: number;
        templateName?: string;
        bodyParams?: Record<string, string>;
        headerParams?: Record<string, string>;
        mediaUrl?: string;
      };
    };

    if (!name) {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }
    if (!triggerType) {
      res.status(400).json({ success: false, error: "triggerConfig.triggerType is required" });
      return;
    }
    if (!template?.wid) {
      res.status(400).json({ success: false, error: "triggerConfig.template.wid is required" });
      return;
    }
    if (
      triggerType === "intent" &&
      (!Array.isArray(keywords) || keywords.length === 0)
    ) {
      res.status(400).json({ success: false, error: "keywords must be a non-empty array for intent trigger type" });
      return;
    }
    if (triggerType === "stage" && !stage) {
      res.status(400).json({ success: false, error: "stage is required for stage trigger type" });
      return;
    }

    const doc = await AutomationRule.create({
      adminId: req.adminId,
      name,
      enabled: enabled ?? true,
      ruleType: "trigger_template",
      triggerConfig: {
        triggerType,
        keywords: keywords ?? [],
        confidenceThreshold: confidenceThreshold ?? 75,
        stage: stage ?? "",
        waitMinutes: waitMinutes ?? 30,
        cooldownHours: cooldownHours ?? 24,
        template: {
          wid: template.wid,
          templateName: template.templateName ?? "",
          bodyParams: template.bodyParams ?? {},
          headerParams: template.headerParams ?? {},
          mediaUrl: template.mediaUrl ?? "",
        },
        lastFired: {},
      },
    });

    const result = doc.toObject() as any;
    if (result.triggerConfig) {
      delete result.triggerConfig.lastFired;
    }

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error("POST /trigger-templates error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to create trigger template",
    });
  }
});

// GET /api/automations/trigger-templates — list all trigger templates
router.get("/trigger-templates", async (req: AuthRequest, res: Response) => {
  try {
    const templates = await AutomationRule.find(
      { adminId: req.adminId, ruleType: "trigger_template" },
      { "triggerConfig.lastFired": 0 }
    ).sort({ createdAt: 1 });

    res.json({ success: true, data: templates });
  } catch (err) {
    console.error("GET /trigger-templates error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch trigger templates",
    });
  }
});

// GET /api/automations/trigger-templates/active/:adminId — public internal route (no auth)
router.get("/trigger-templates/active/:adminId", async (req: Request, res: Response) => {
  try {
    const { adminId } = req.params;

    const templates = await AutomationRule.find({
      adminId,
      ruleType: "trigger_template",
      enabled: true,
    });

    res.json({ success: true, data: templates });
  } catch (err) {
    console.error("GET /trigger-templates/active/:adminId error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch active trigger templates",
    });
  }
});

// PATCH /api/automations/trigger-templates/:id — update a trigger template
router.patch("/trigger-templates/:id", async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      enabled,
      triggerType,
      keywords,
      confidenceThreshold,
      stage,
      waitMinutes,
      cooldownHours,
      template,
      lastFired: _lf,
      ruleType: _rt,
      adminId: _aid,
    } = req.body as Record<string, unknown>;

    const setPayload: Record<string, unknown> = {};

    if (name !== undefined)                setPayload["name"]                               = name;
    if (enabled !== undefined)             setPayload["enabled"]                            = enabled;
    if (triggerType !== undefined)         setPayload["triggerConfig.triggerType"]          = triggerType;
    if (keywords !== undefined)            setPayload["triggerConfig.keywords"]             = keywords;
    if (confidenceThreshold !== undefined) setPayload["triggerConfig.confidenceThreshold"]  = confidenceThreshold;
    if (stage !== undefined)               setPayload["triggerConfig.stage"]                = stage;
    if (waitMinutes !== undefined)         setPayload["triggerConfig.waitMinutes"]          = waitMinutes;
    if (cooldownHours !== undefined)       setPayload["triggerConfig.cooldownHours"]        = cooldownHours;
    if (template !== undefined)            setPayload["triggerConfig.template"]             = template;

    const doc = await AutomationRule.findOneAndUpdate(
      { _id: req.params.id, adminId: req.adminId, ruleType: "trigger_template" },
      { $set: setPayload },
      { new: true }
    ).select({ "triggerConfig.lastFired": 0 });

    if (!doc) {
      res.status(404).json({ success: false, error: "Trigger template not found" });
      return;
    }

    res.json({ success: true, data: doc });
  } catch (err) {
    console.error("PATCH /trigger-templates/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update trigger template",
    });
  }
});

// DELETE /api/automations/trigger-templates/:id — delete a trigger template
router.delete("/trigger-templates/:id", async (req: AuthRequest, res: Response) => {
  try {
    const doc = await AutomationRule.findOneAndDelete({
      _id: req.params.id,
      adminId: req.adminId,
      ruleType: "trigger_template",
    });

    if (!doc) {
      res.status(404).json({ success: false, error: "Trigger template not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /trigger-templates/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete trigger template",
    });
  }
});

export default router;
