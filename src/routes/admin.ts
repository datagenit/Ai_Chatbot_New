import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { ingest } from "../ingestion/ingest.js";

const router = Router();

// Get directory paths for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { adminId } = req.body as { adminId?: string };
    if (!adminId) {
      return res.status(400).json({ error: "adminId is required" });
    }

    const filePath = req.file.path;
    const chunkCount = await ingest(filePath, adminId);

    res.json({
      success: true,
      message: `Successfully ingested ${chunkCount} chunks`,
      chunks: chunkCount,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Upload failed",
    });
  }
});

export default router;
