import { Router, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import { ingest, ingestContent, ingestText, ingestURL } from "../ingestion/ingest.js";
import {
  validateURL,
  checkDuplicateSource,
  checkAdminSourceLimit,
} from "../ingestion/safeguards.js";
import { deleteVectors } from "../ingestion/retriever.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import AdminConfig from "../models/AdminConfig.js";
import UploadedFile from "../models/UploadedFile.js";
import UsageLog from "../models/UsageLog.js";
import type { AuthRequest } from "../middleware/auth.js";
import Conversation from "../models/Conversation.js";
import MissedQuery from "../models/MissedQuery.js";

const router = Router();

// ── Multer setup for file uploads ──────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf") {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} is not allowed`));
    }
  },
});

// ── POST /api/admin/upload ──────────────────────────────────────────────────
router.post("/upload", (req: AuthRequest, res: Response, next) => {
  upload.single("file")(req, res as any, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ success: false, error: "File too large. Maximum allowed size is 50MB." });
      return;
    }
    if (err) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    next();
  });
}, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: "No file uploaded" });
      return;
    }

    const adminId = req.adminId!;

    const isDuplicate = await checkDuplicateSource(adminId, req.file.originalname);
    if (isDuplicate) {
      res.status(409).json({
        success: false,
        error: "A document with this name already exists in your knowledge base",
      });
      return;
    }

    const limitReached = await checkAdminSourceLimit(adminId, "pdf");
    if (limitReached) {
      res.status(429).json({
        success: false,
        error: "PDF source limit reached (max 25). Delete existing sources to add new ones.",
      });
      return;
    }

    const newId = new mongoose.Types.ObjectId();
    const { chunks, vectorIds, content } = await ingest(
      req.file.buffer,
      req.file.originalname,
      adminId,
      String(newId)
    );

    const savedDoc = await UploadedFile.create({
      _id: newId,
      adminId,
      originalName: req.file.originalname,
      filePath: req.file.originalname,
      chunks,
      vectorIds,
      content,
      type: "pdf",
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

// ── POST /api/admin/upload/text ─────────────────────────────────────────────
router.post("/upload/text", async (req: AuthRequest, res: Response) => {
  try {
    const { content, sourceName } = req.body as {
      content?: string;
      sourceName?: string;
    };

    if (!content || !content.trim()) {
      res.status(400).json({ success: false, error: "Content is required" });
      return;
    }

    const adminId = req.adminId!;
    const resolvedSourceName = sourceName?.trim() || `Text Entry ${Date.now()}`;
    const textFilePath = `text-input-${resolvedSourceName}`;

    const isDuplicate = await checkDuplicateSource(adminId, textFilePath);
    if (isDuplicate) {
      res.status(409).json({ success: false, error: "A text entry with this name already exists" });
      return;
    }

    const limitReached = await checkAdminSourceLimit(adminId, "text");
    if (limitReached) {
      res.status(429).json({
        success: false,
        error: "Text source limit reached (max 25). Delete existing sources to add new ones.",
      });
      return;
    }

    const newId = new mongoose.Types.ObjectId();
    const { chunks, vectorIds } = await ingestText(
      adminId,
      content.trim(),
      resolvedSourceName,
      String(newId)
    );

    const savedDoc = await UploadedFile.create({
      _id: newId,
      adminId,
      originalName: resolvedSourceName,
      filePath: textFilePath,
      chunks,
      vectorIds,
      content,
      type: "text",
    });

    res.json({
      success: true,
      message: `Successfully ingested ${chunks} chunks`,
      chunks,
      documentId: savedDoc._id,
    });
  } catch (err) {
    console.error("Text upload error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Text ingestion failed",
    });
  }
});

// ── POST /api/admin/upload/url ──────────────────────────────────────────────
router.post("/upload/url", async (req: AuthRequest, res: Response) => {
  try {
    const { url } = req.body as { url?: string };

    if (!url || !url.trim()) {
      res.status(400).json({ success: false, error: "URL is required" });
      return;
    }

    const trimmedUrl = url.trim();
    const adminId = req.adminId!;

    const urlCheck = validateURL(trimmedUrl);
    if (!urlCheck.valid) {
      res.status(400).json({ success: false, error: urlCheck.reason });
      return;
    }

    const isDuplicate = await checkDuplicateSource(adminId, trimmedUrl);
    if (isDuplicate) {
      res.status(409).json({
        success: false,
        error: "This URL has already been added to your knowledge base",
      });
      return;
    }

    const limitReached = await checkAdminSourceLimit(adminId, "url");
    if (limitReached) {
      res.status(429).json({
        success: false,
        error: "URL source limit reached (max 25). Delete existing sources to add new ones.",
      });
      return;
    }

    const newId = new mongoose.Types.ObjectId();
    const result = await ingestURL(adminId, trimmedUrl, String(newId));

    const savedDoc = await UploadedFile.create({
      _id: newId,
      adminId,
      originalName: result.title,
      filePath: trimmedUrl,
      chunks: result.chunks,
      vectorIds: result.vectorIds,
      content: result.content,
      type: "url",
    });

    res.json({
      success: true,
      message: `Successfully ingested ${result.chunks} chunks from ${result.title}`,
      chunks: result.chunks,
      title: result.title,
      documentId: savedDoc._id,
    });
  } catch (err) {
    console.error("URL upload error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "URL ingestion failed",
    });
  }
});

// ── GET /api/admin/documents ────────────────────────────────────────────────
router.get("/documents", async (req: AuthRequest, res: Response) => {
  try {
    const docs = await UploadedFile.find({ adminId: req.adminId })
      .sort({ uploadedAt: -1 })
      .select("_id originalName chunks uploadedAt adminId filePath");

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
      "_id originalName chunks uploadedAt filePath content"
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

// ── PATCH /api/admin/documents/:id ───────────────────────────────────────────
router.patch("/documents/:id", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;
    const { content } = req.body as { content?: string };

    if (!content || !content.trim()) {
      res.status(400).json({ success: false, error: "Content is required" });
      return;
    }

    const doc = await UploadedFile.findOne({ _id: req.params.id, adminId });
    if (!doc) {
      res.status(404).json({ success: false, error: "Document not found" });
      return;
    }

    const nextContent = content.trim();
    const source = doc.type === "url" ? doc.filePath : doc.originalName;
    const metadata = {
      source,
      type: doc.type,
      documentId: String(doc._id),
      ...(doc.type === "url" ? { title: doc.originalName } : {}),
    } as const;

    const { chunks, vectorIds } = await ingestContent(nextContent, adminId, metadata, doc.vectorIds);

    const updatedDoc = await UploadedFile.findOneAndUpdate(
      { _id: req.params.id, adminId },
      { $set: { content: nextContent, vectorIds, chunks, updatedAt: new Date() } as any },
      { new: true }
    );

    res.status(200).json({ success: true, doc: updatedDoc });
  } catch (err) {
    console.error("PATCH /documents/:id error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update document",
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

    await deleteVectors(adminId, doc.vectorIds, String(doc._id));

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
    const adminId = req.adminId!;

    const config = await AdminConfig.findOneAndUpdate(
      { adminId },
      {
        $setOnInsert: {
          adminId,
          tools: {
            get_current_datetime: true,
            search_knowledge_base: true,
            search_web: false,
            create_ticket: false,
          },
          kb: {
            maxResults: 5,
          },
          conversationTtlDays: 30,
          confirmBeforeTicket: false,
          customSystemPrompt: '',
          kbOnlyMode: false,
        },
      },
      {
        new: true,       // return the document after update
        upsert: true,    // create if doesn't exist
      }
    );

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
        create_ticket?: boolean;
      };
      kb?: { maxResults?: number };
    };

    const config = await AdminConfig.create({
      adminId,
      tools: {
        get_current_datetime: tools?.get_current_datetime ?? true,
        search_knowledge_base: tools?.search_knowledge_base ?? true,
        search_web: tools?.search_web ?? false,
        create_ticket: tools?.create_ticket ?? false,
      },
      kb: {
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

// ── PATCH /api/admin/agent-prompt ────────────────────────────────────────────
router.patch("/agent-prompt", async (req: AuthRequest, res: Response) => {
  try {
    const config = await AdminConfig.findOne({ adminId: req.adminId });
    if (!config) {
      res.status(404).json({ success: false, error: "Config not found" });
      return;
    }

    if (typeof req.body.customSystemPrompt === "string") {
      config.customSystemPrompt = req.body.customSystemPrompt;
    }
    if (typeof req.body.kbOnlyMode === "boolean") {
      config.kbOnlyMode = req.body.kbOnlyMode;
    }

    await config.save();
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /agent-prompt error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update agent prompt settings",
    });
  }
});

// ── PATCH /api/admin/ticket-settings ────────────────────────────────────────
router.patch("/ticket-settings", async (req: AuthRequest, res: Response) => {
  try {
    const { confirmBeforeTicket } = req.body as { confirmBeforeTicket?: unknown };

    if (typeof confirmBeforeTicket !== "boolean") {
      res.status(400).json({ success: false, error: "confirmBeforeTicket must be a boolean" });
      return;
    }

    const config = await AdminConfig.findOne({ adminId: req.adminId });
    if (!config) {
      res.status(404).json({ success: false, error: "Config not found" });
      return;
    }

    config.confirmBeforeTicket = confirmBeforeTicket;
    await config.save();

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /ticket-settings error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update ticket settings",
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
        create_ticket?: boolean;
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
    if (typeof tools.create_ticket === "boolean") {
      setFields["tools.create_ticket"] = tools.create_ticket;
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

// ── GET /api/admin/usage ─────────────────────────────────────────────────────
router.get("/usage", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;
    const { from, to } = req.query as { from?: string; to?: string };

    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const matchStage: Record<string, unknown> = { adminId };
    if (Object.keys(dateFilter).length) matchStage.createdAt = dateFilter;

    const [summaryResult, dailyResult] = await Promise.all([
      UsageLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalInputTokens: { $sum: "$inputTokens" },
            totalOutputTokens: { $sum: "$outputTokens" },
            totalTokens: { $sum: "$totalTokens" },
            totalRequests: { $sum: 1 },
            whatsappRequests: {
              $sum: { $cond: [{ $eq: ["$source", "whatsapp"] }, 1, 0] },
            },
            testRequests: {
              $sum: { $cond: [{ $eq: ["$source", "test"] }, 1, 0] },
            },
            errorRequests: {
              $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
            },
            avgLatencyMs: { $avg: { $ifNull: ["$latencyMs", null] } },
          },
        },
      ]),
      UsageLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            tokens: { $sum: "$totalTokens" },
            requests: { $sum: 1 },
            avgLatencyMs: { $avg: { $ifNull: ["$latencyMs", null] } },
            errors: {
              $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0,
            date: "$_id",
            tokens: 1,
            requests: 1,
            avgLatencyMs: { $round: [{ $ifNull: ["$avgLatencyMs", 0] }, 0] },
            errors: 1,
          },
        },
      ]),
    ]);

    const summary = summaryResult[0]
      ? {
        totalInputTokens: summaryResult[0].totalInputTokens,
        totalOutputTokens: summaryResult[0].totalOutputTokens,
        totalTokens: summaryResult[0].totalTokens,
        totalRequests: summaryResult[0].totalRequests,
        whatsappRequests: summaryResult[0].whatsappRequests,
        testRequests: summaryResult[0].testRequests,
        errorRequests: summaryResult[0].errorRequests,
        avgLatencyMs: Math.round(summaryResult[0].avgLatencyMs ?? 0),
      }
      : {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
        whatsappRequests: 0,
        testRequests: 0,
        errorRequests: 0,
        avgLatencyMs: 0,
      };

    res.json({ success: true, summary, daily: dailyResult });
  } catch (err) {
    console.error("GET /usage error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch usage",
    });
  }
});

// ── GET /api/admin/usage/top-threads ─────────────────────────────────────────
router.get("/usage/top-threads", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;
    const { from, to, limit: limitParam } = req.query as {
      from?: string;
      to?: string;
      limit?: string;
    };

    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const matchStage: Record<string, unknown> = { adminId };
    if (Object.keys(dateFilter).length) matchStage.createdAt = dateFilter;

    const limitVal = Math.min(parseInt(limitParam ?? "10", 10) || 10, 50);

    const data = await UsageLog.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$threadId",
          tokens: { $sum: "$totalTokens" },
          requests: { $sum: 1 },
          avgLatencyMs: { $avg: { $ifNull: ["$latencyMs", null] } },
          lastUsed: { $max: "$createdAt" },
        },
      },
      { $sort: { tokens: -1 } },
      { $limit: limitVal },
      {
        $project: {
          _id: 0,
          threadId: "$_id",
          tokens: 1,
          requests: 1,
          avgLatencyMs: { $round: [{ $ifNull: ["$avgLatencyMs", 0] }, 0] },
          lastUsed: 1,
        },
      },
    ]);

    res.json({ success: true, data });
  } catch (err) {
    console.error("GET /usage/top-threads error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch top threads",
    });
  }
});

// ── DELETE /api/admin/usage ───────────────────────────────────────────────────
router.delete("/usage", async (req: AuthRequest, res: Response) => {
  try {
    await UsageLog.deleteMany({ adminId: req.adminId });
    res.json({ success: true, message: "Usage logs cleared" });
  } catch (err) {
    console.error("DELETE /usage error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to clear usage logs",
    });
  }
});

// ── GET /api/admin/missed-queries ─────────────────────────────────────────
router.get("/missed-queries", async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.adminId!;
    const { status = "open", limit: limitParam } = req.query as {
      status?: string;
      limit?: string;
    };

    const validStatuses = ["open", "dismissed", "added_to_kb", "all"];
    const statusFilter = validStatuses.includes(status) ? status : "open";

    const match: Record<string, unknown> = { adminId };
    if (statusFilter !== "all") match.status = statusFilter;

    const limitVal = Math.min(parseInt(limitParam ?? "100", 10) || 100, 200);

    const queries = await MissedQuery.find(match)
      .sort({ count: -1, lastSeenAt: -1 })
      .limit(limitVal)
      .select("_id query threadId source count status suggestedAnswer lastSeenAt createdAt");

    res.json({ success: true, data: queries, total: queries.length });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch missed queries",
    });
  }
});

// ── PATCH /api/admin/missed-queries/:id ───────────────────────────────────
router.patch("/missed-queries/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body as { status?: string };
    const validStatuses = ["open", "dismissed", "added_to_kb"];

    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
      return;
    }

    const doc = await MissedQuery.findOneAndUpdate(
      { _id: req.params.id, adminId: req.adminId },
      { $set: { status } },
      { new: true }
    );

    if (!doc) {
      res.status(404).json({ success: false, error: "Query not found" });
      return;
    }

    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to update status",
    });
  }
});

// ── POST /api/admin/missed-queries/:id/suggest ────────────────────────────
router.post("/missed-queries/:id/suggest", async (req: AuthRequest, res: Response) => {
  try {
    const doc = await MissedQuery.findOne({
      _id: req.params.id,
      adminId: req.adminId,
    });

    if (!doc) {
      res.status(404).json({ success: false, error: "Query not found" });
      return;
    }

    // Return cached suggestion if already generated
    if (doc.suggestedAnswer) {
      res.json({ success: true, suggestion: doc.suggestedAnswer });
      return;
    }

    // Generate with Gemini Flash
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `A customer asked the following question that the AI could not answer from the knowledge base:

"${doc.query}"

Write a clear, accurate, and helpful knowledge base article answer for this question.
- Be concise but complete (2-4 paragraphs max)
- Use plain language
- Do not include headers or markdown
- Write as if you are directly answering the customer`;

    const result = await model.generateContent(prompt);
    const suggestion = result.response.text().trim();

    // Cache it on the document
    await MissedQuery.findByIdAndUpdate(doc._id, {
      $set: { suggestedAnswer: suggestion },
    });

    res.json({ success: true, suggestion });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to generate suggestion",
    });
  }
});

// ── DELETE /api/admin/missed-queries ──────────────────────────────────────
router.delete("/missed-queries", async (req: AuthRequest, res: Response) => {
  try {
    await MissedQuery.deleteMany({ adminId: req.adminId });
    res.json({ success: true, message: "Missed queries cleared" });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to clear missed queries",
    });
  }
});

export default router;
