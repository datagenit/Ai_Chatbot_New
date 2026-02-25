import { Router, Response } from "express";
import AutomationRule from "../models/AutomationRule.js";
import AdminCredentials from "../models/AdminCredentials.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();



// ── Credentials ───────────────────────────────────────────────────────────────

// POST /api/automations/credentials — save CPaaS credentials
router.post("/credentials", async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, token, email } = req.body as {
      user_id?: number;
      token?: string;
      email?: string;
    };

    if (!user_id || !token || !email) {
      res.status(400).json({
        success: false,
        error: "user_id, token, and email are required",
      });
      return;
    }

    const credentials = await AdminCredentials.findOneAndUpdate(
      { adminId: req.adminId },
      { $set: { user_id, token, email } },
      { returnDocument: 'after', upsert: true }
    );

    // Never expose token in response
    const safe = {
      adminId: credentials.adminId,
      user_id: credentials.user_id,
      email: credentials.email,
      createdAt: credentials.createdAt,
    };

    res.json({ success: true, data: safe });
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

    if (!credentials) {
      res.status(404).json({
        success: false,
        error: "No CPaaS credentials found for this admin",
      });
      return;
    }

    res.json({ success: true, data: credentials });
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



export default router;
