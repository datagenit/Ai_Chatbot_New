/**
 * One-time migration script — run once then delete.
 * Fixes existing UploadedFile docs and Pinecone vector metadata.
 *
 * Run with: npx tsx src/scripts/migrateKbMetadata.ts
 */
import mongoose from "mongoose";
import { Pinecone } from "@pinecone-database/pinecone";
import UploadedFile from "../models/UploadedFile.js";
import { env } from "../config/env.js";

async function migrate() {
  await mongoose.connect(env.MONGODB_URI);
  console.log("[migrate] Connected to MongoDB");

  const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  const pineconeIndex = pinecone.Index(env.PINECONE_INDEX_NAME);

  const docs = await UploadedFile.find({});
  console.log(`[migrate] Found ${docs.length} documents`);

  let mongoFixed = 0;
  let pineconeFixed = 0;
  let pineconeErrors = 0;

  for (const doc of docs) {
    // ── Determine type from filePath ─────────────────────────────────────
    let type: "pdf" | "text" | "url";
    if (doc.filePath.startsWith("http")) {
      type = "url";
    } else if (doc.filePath.startsWith("text-input-")) {
      type = "text";
    } else {
      type = "pdf";
    }

    // ── Fix MongoDB doc ──────────────────────────────────────────────────
    let mongoChanged = false;

    // @ts-ignore — type field may not exist on old docs
    if (!doc.type) {
      // @ts-ignore
      doc.type = type;
      mongoChanged = true;
    }

    // Fix filePath for PDFs — set to originalName if it's a temp path
    if (
      type === "pdf" &&
      doc.filePath !== doc.originalName &&
      !doc.filePath.startsWith("http") &&
      !doc.filePath.startsWith("text-input-")
    ) {
      doc.filePath = doc.originalName;
      mongoChanged = true;
    }

    if (mongoChanged) {
      await doc.save();
      mongoFixed++;
      console.log(`[migrate] Fixed MongoDB doc: ${doc.originalName}`);
    }

    // ── Fix Pinecone vectors ──────────────────────────────────────────────
    if (!doc.vectorIds?.length) continue;

    const namespace = `kb_${doc.adminId}`;
    const namespacedIndex = pineconeIndex.namespace(namespace);

    for (const vectorId of doc.vectorIds) {
      try {
        await namespacedIndex.update({
          id: vectorId,
          metadata: {
            source: doc.originalName,
            type,
            documentId: doc._id.toString(),
            adminId: doc.adminId,
          },
        });
        pineconeFixed++;
      } catch (err) {
        console.warn(
          `[migrate] Failed to update vector ${vectorId} for doc ${doc.originalName}:`,
          err instanceof Error ? err.message : err
        );
        pineconeErrors++;
      }
    }

    console.log(
      `[migrate] Updated ${doc.vectorIds.length} vectors for: ${doc.originalName}`
    );
  }

  console.log("\n[migrate] ── Summary ──────────────────────────────────");
  console.log(`  MongoDB docs fixed:    ${mongoFixed}`);
  console.log(`  Pinecone vectors fixed: ${pineconeFixed}`);
  console.log(`  Pinecone errors:        ${pineconeErrors}`);
  console.log("[migrate] Done. You can delete this script.");

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
