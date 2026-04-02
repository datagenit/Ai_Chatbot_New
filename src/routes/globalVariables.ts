import { Router, Response } from "express";
import GlobalVariable from "../models/GlobalVariable.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();

// ── GET /keys — return key names only (MUST be before /:id) ──────────────────

router.get("/keys", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const vars = await GlobalVariable.find({ adminId })
      .select("key")
      .sort({ key: 1 })
      .lean();

    res.json({ keys: vars.map((v) => v.key) });
  } catch (err) {
    console.error("GET /globals/keys error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to fetch global variable keys" });
  }
});

// ── GET / — list all globals ──────────────────────────────────────────────────

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const variables = await GlobalVariable.find({ adminId }).sort({ key: 1 });
    res.json({ variables });
  } catch (err) {
    console.error("GET /globals error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to fetch global variables" });
  }
});

// ── POST / — create a global variable ────────────────────────────────────────

router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const { key: rawKey, value, description } = req.body as {
      key?: string;
      value?: string;
      description?: string;
    };

    if (!rawKey || typeof rawKey !== "string" || rawKey.trim().length === 0) {
      res.status(400).json({ error: "key is required" });
      return;
    }

    // Normalise: lowercase, trim, spaces → underscores
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, "_");

    const variable = await GlobalVariable.create({
      adminId,
      key,
      value:       value       ?? "",
      description: description ?? "",
    });

    res.status(201).json({ variable });
  } catch (err: unknown) {
    // MongoDB duplicate-key error code
    if ((err as any)?.code === 11000) {
      res.status(409).json({ error: "Key already exists" });
      return;
    }
    console.error("POST /globals error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to create global variable" });
  }
});

// ── PUT /:id — update value / description (key is immutable) ─────────────────

router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const { value, description } = req.body as {
      value?: string;
      description?: string;
    };

    const setPayload: Record<string, unknown> = { updatedAt: new Date() };
    if (value       !== undefined) setPayload.value       = value;
    if (description !== undefined) setPayload.description = description;

    const variable = await GlobalVariable.findOneAndUpdate(
      { _id: req.params.id, adminId },
      { $set: setPayload },
      { new: true }
    );

    if (!variable) {
      res.status(404).json({ error: "Global variable not found" });
      return;
    }

    res.json({ variable });
  } catch (err) {
    console.error("PUT /globals/:id error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to update global variable" });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId;
    const variable = await GlobalVariable.findOneAndDelete({
      _id: req.params.id,
      adminId,
    });

    if (!variable) {
      res.status(404).json({ error: "Global variable not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /globals/:id error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to delete global variable" });
  }
});

export default router;
