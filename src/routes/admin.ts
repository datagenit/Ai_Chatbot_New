import { Router, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { ingest } from "../ingestion/ingest.js";
import { deleteVectors } from "../ingestion/retriever.js";
import AdminConfig from "../models/AdminConfig.js";
import UploadedFile from "../models/UploadedFile.js";
import type { AuthRequest } from "../middleware/auth.js";
import Conversation from "../models/Conversation.js";

const router = Router();

// ── Multer setup for file uploads ──────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, "../uploads"));
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({ storage });

// ── POST /api/admin/upload ──────────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: "No file uploaded" });
      return;
    }

    const adminId = req.adminId!;
    const { chunks, vectorIds } = await ingest(req.file.path, adminId);

    const savedDoc = await UploadedFile.create({
      adminId,
      originalName: req.file.originalname,
      filePath: req.file.path,
      chunks,
      vectorIds,
    });

    res.json({
      success: true,
      message: `Successfully ingested ${chunks} chunks`,
      chunks,
      documentId: savedDoc._id,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Upload failed",
    });
  }
});

// ── GET /api/admin/documents ────────────────────────────────────────────────
router.get("/documents", async (req: AuthRequest, res: Response) => {
  try {
    const docs = await UploadedFile.find({ adminId: req.adminId })
      .sort({ uploadedAt: -1 })
      .select("_id originalName chunks uploadedAt adminId");

    res.json({ success: true, data: docs });
  } catch (err) {
    console.error("GET /documents error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch documents",
    });
  }
});

// ── GET /api/admin/documents/:id ────────────────────────────────────────────
router.get("/documents/:id", async (req: AuthRequest, res: Response) => {
  try {
    const doc = await UploadedFile.findOne({ _id: req.params.id, adminId: req.adminId }).select(
      "_id originalName chunks uploadedAt"
    );

    if (!doc) {
      res.status(404).json({ success: false, error: "Document not found" });
      return;
    }

    res.json({ success: true, data: doc });
  } catch (err) {
    console.error("GET /documents/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch document",
    });
  }
});

// ── DELETE /api/admin/documents/:id ─────────────────────────────────────────
router.delete("/documents/:id", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;
    const doc = await UploadedFile.findOne({ _id: req.params.id, adminId });

    if (!doc) {
      res.status(404).json({ success: false, error: "Document not found" });
      return;
    }

    await deleteVectors(adminId, doc.vectorIds);

    try {
      fs.unlinkSync(doc.filePath);
    } catch (fileErr) {
      console.error(`[Upload] Could not delete file ${doc.filePath}:`, fileErr);
    }

    await doc.deleteOne();

    res.json({ success: true, message: "Document deleted" });
  } catch (err) {
    console.error("DELETE /documents/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete document",
    });
  }
});

// ── GET /api/admin/me ───────────────────────────────────────────────────────
router.get("/me", async (req: AuthRequest, res: Response) => {
  try {
    const config = await AdminConfig.findOne({ adminId: req.adminId });

    if (!config) {
      res.status(404).json({ success: false, error: "Admin config not found" });
      return;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error("GET /me error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch admin config",
    });
  }
});

// ── POST /api/admin/setup ───────────────────────────────────────────────────
router.post("/setup", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;

    const existing = await AdminConfig.findOne({ adminId });
    if (existing) {
      res.status(409).json({ success: false, error: "Admin config already exists" });
      return;
    }

    const { tools, kb } = req.body as {
      tools?: {
        get_current_datetime?: boolean;
        search_knowledge_base?: boolean;
        search_web?: boolean;
      };
      kb?: { maxResults?: number };
    };

    const config = await AdminConfig.create({
      adminId,
      tools: {
        get_current_datetime: tools?.get_current_datetime ?? true,
        search_knowledge_base: tools?.search_knowledge_base ?? true,
        search_web: tools?.search_web ?? false,
      },
      kb: {
        collectionName: `kb_${adminId}`,   // always auto-set; never from client
        maxResults: kb?.maxResults ?? 5,
      },
    });

    res.status(201).json({ success: true, data: config });
  } catch (err) {
    console.error("POST /setup error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to create admin config",
    });
  }
});

// ── PATCH /api/admin/tools ──────────────────────────────────────────────────
router.patch("/tools", async (req: AuthRequest, res: Response) => {
  try {
    const { tools } = req.body as {
      tools?: {
        get_current_datetime?: boolean;
        search_knowledge_base?: boolean;
        search_web?: boolean;
      };
    };

    if (!tools || typeof tools !== "object") {
      res.status(400).json({ success: false, error: "tools object is required" });
      return;
    }

    // Build a partial $set so only supplied booleans are updated
    const setFields: Record<string, boolean> = {};
    if (typeof tools.get_current_datetime === "boolean") {
      setFields["tools.get_current_datetime"] = tools.get_current_datetime;
    }
    if (typeof tools.search_knowledge_base === "boolean") {
      setFields["tools.search_knowledge_base"] = tools.search_knowledge_base;
    }
    if (typeof tools.search_web === "boolean") {
      setFields["tools.search_web"] = tools.search_web;
    }

    const config = await AdminConfig.findOneAndUpdate(
      { adminId: req.adminId },
      { $set: setFields },
      { new: true }
    );

    if (!config) {
      res.status(404).json({ success: false, error: "Admin config not found" });
      return;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error("PATCH /tools error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update tools",
    });
  }
});

// ── PATCH /api/admin/kb ─────────────────────────────────────────────────────
router.patch("/kb", async (req: AuthRequest, res: Response) => {
  try {
    const { maxResults } = req.body as { maxResults?: unknown };

    if (typeof maxResults !== "number" || maxResults < 1 || maxResults > 20) {
      res.status(400).json({
        success: false,
        error: "maxResults must be a number between 1 and 20",
      });
      return;
    }

    const config = await AdminConfig.findOneAndUpdate(
      { adminId: req.adminId },
      { $set: { "kb.maxResults": maxResults } },  // collectionName is never touched
      { new: true }
    );

    if (!config) {
      res.status(404).json({ success: false, error: "Admin config not found" });
      return;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error("PATCH /kb error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update kb config",
    });
  }
});

// ── DELETE /api/admin/me ────────────────────────────────────────────────────
router.delete("/me", async (req: AuthRequest, res: Response) => {
  try {
    const deleted = await AdminConfig.findOneAndDelete({ adminId: req.adminId });

    if (!deleted) {
      res.status(404).json({ success: false, error: "Admin config not found" });
      return;
    }

    res.json({ success: true, message: "Admin config deleted" });
  } catch (err) {
    console.error("DELETE /me error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete admin config",
    });
  }
});

// DELETE /api/admin/conversations/:threadId — clear test conversation
router.delete("/conversations/:threadId", async (req: AuthRequest, res: Response) => {
  try {
    await Conversation.deleteOne({
      threadId: req.params.threadId,
      adminId: req.adminId,
    });
    res.json({ success: true, message: "Conversation cleared" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to clear conversation" });
  }
});

// GET /api/admin/conversations/:threadId — fetch conversation history
router.get("/conversations/:threadId", async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await Conversation.findOne({
      threadId: req.params.threadId,
      adminId: req.adminId,
    });
    res.json({ success: true, data: conversation?.messages ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch conversation" });
  }
});

router.patch("/conversation-ttl", async (req: AuthRequest, res: Response) => {
  try {
    const { conversationTtlDays } = req.body as { conversationTtlDays?: unknown };

    if (
      typeof conversationTtlDays !== "number" ||
      conversationTtlDays < 1 ||
      conversationTtlDays > 365
    ) {
      res.status(400).json({
        success: false,
        error: "conversationTtlDays must be a number between 1 and 365",
      });
      return;
    }

    const config = await AdminConfig.findOneAndUpdate(
      { adminId: req.adminId },
      { $set: { conversationTtlDays } },
      { new: true }
    );

    if (!config) {
      res.status(404).json({ success: false, error: "Admin config not found" });
      return;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update TTL",
    });
  }
});

router.get("/documents/:id/file", async (req: AuthRequest, res: Response) => {
  try {
    const doc = await UploadedFile.findOne({
      _id: req.params.id,
      adminId: req.adminId,
    });

    if (!doc) {
      res.status(404).json({ success: false, error: "Document not found" });
      return;
    }

    if (!doc.filePath || !fs.existsSync(doc.filePath)) {
      res.status(404).json({ success: false, error: "File not found on server" });
      return;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${doc.originalName}"` // inline = open in browser, not download
    );

    fs.createReadStream(doc.filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to serve file" });
  }
});


export default router;
