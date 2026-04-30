// src/ingestion/ingest.ts
import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { v4 as uuidv4 } from "uuid";
import { fromBuffer } from "pdf2pic";
import Tesseract from "tesseract.js";
import axios from "axios";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { validateContentSize, validateMinContent } from "./safeguards.js";
import { env, PINECONE_NS_PREFIX } from "../config/env.js";

const pinecone = new PineconeClient({ apiKey: env.PINECONE_API_KEY });

const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2",
});

export async function ingestContent(
  text: string,
  adminId: string,
  metadata: { source: string; type: "pdf" | "text" | "url"; documentId: string; title?: string },
  existingVectorIds?: string[]
): Promise<{ vectorIds: string[]; chunks: number }> {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1500,
    chunkOverlap: 150,
    separators: ["\n\n", "\n", ". ", "! ", "? ", " ", ""],
  });

  let rawChunks = await textSplitter.splitText(text);
  if (rawChunks.length > 100) {
    console.warn("[ingest] chunks capped at 100");
    rawChunks = rawChunks.slice(0, 100);
  }

  const totalChunks = rawChunks.length;
  const documents = rawChunks.map(
    (chunkText, index) =>
      new Document({
        pageContent: `[Source: ${metadata.title ?? metadata.source} | Part ${index + 1} of ${totalChunks}]\n\n${chunkText}`,
        metadata: {
          adminId,
          source: metadata.source,
          type: metadata.type,
          documentId: metadata.documentId,
          ...(metadata.title ? { title: metadata.title } : {}),
          chunkIndex: index,
        },
      })
  );

  const namespace = `${PINECONE_NS_PREFIX}kb_${adminId}`;
  const pineconeIndex = pinecone.Index(env.PINECONE_INDEX_NAME);

  if (existingVectorIds?.length) {
    await pineconeIndex.namespace(namespace).deleteMany(existingVectorIds);
  }

  const vectorIds = documents.map(() => uuidv4());

  await PineconeStore.fromDocuments(documents, embeddings, {
    pineconeIndex: pineconeIndex as any,
    namespace,
    ids: vectorIds,
  } as any);

  return { vectorIds, chunks: documents.length };
}

/**
 * Ingests a PDF file into Pinecone for a specific admin.
 * @param buffer - PDF file bytes
 * @param filename - Original PDF filename
 * @param adminId - Admin identifier for multi-tenant isolation
 * @returns Object with chunk count and vector IDs stored in Pinecone
 */
export async function ingest(
  buffer: Buffer,
  filename: string,
  adminId: string
): Promise<{ chunks: number; vectorIds: string[]; content: string }> {
  // Load PDF from memory buffer
  const pdfData = await pdfParse(buffer);
  const documents = [
    new Document({
      pageContent: pdfData.text,
      metadata: { source: filename },
    }),
  ];

  // ── OCR enrichment — only for pages with little/no extracted text ─────────
  try {
    const pageCount = Math.min(documents.length, 20);
    const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);

    const converter = fromBuffer(buffer, {
      density: 150,
      format: "png",
      width: 1200,
      height: 1600,
    });

    const bufferResponses = await converter.bulk(pageNumbers, { responseType: "buffer" });

    for (let i = 0; i < bufferResponses.length; i++) {
      const buf = bufferResponses[i]?.buffer;

      // skip if buffer is missing or empty
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) continue;

      // skip OCR if page already has substantial text
      if (documents[i]?.pageContent?.trim().length > 100) continue;

      try {
        const { data } = await Tesseract.recognize(buf, "eng");
        const ocrText = data.text?.trim();
        if (ocrText) {
          documents[i].pageContent += `\n${ocrText}`;
        }
      } catch (pageErr) {
        console.warn(
          `[ingest] OCR failed for page ${i + 1}, skipping:`,
          pageErr instanceof Error ? pageErr.message : pageErr
        );
      }
    }
  } catch (err) {
    console.warn(
      "[ingest] OCR setup failed, continuing text-only:",
      err instanceof Error ? err.message : err
    );
  }

  // ── Safeguards — validate and cap content before splitting ──────────────
  const fullText = documents.map((d) => d.pageContent).join("\n");
  const safeText = validateContentSize(fullText, filename);
  if (!validateMinContent(safeText)) {
    throw new Error("PDF has no extractable text content");
  }
  const documentId = uuidv4();
  const { chunks, vectorIds } = await ingestContent(
    safeText,
    adminId,
    { source: filename, type: "pdf", documentId }
  );

  return { chunks, vectorIds, content: safeText };
}

/**
 * Ingests plain text content into Pinecone for a specific admin.
 * @param adminId - Admin identifier for multi-tenant isolation
 * @param content - Raw text content to ingest
 * @param sourceName - Human-readable label stored in metadata
 * @returns Object with chunk count and vector IDs stored in Pinecone
 */
export async function ingestText(
  adminId: string,
  content: string,
  sourceName: string
): Promise<{ chunks: number; vectorIds: string[] }> {
  const safeContent = validateContentSize(content, sourceName);
  if (!validateMinContent(safeContent)) {
    throw new Error("Text content is too short (min 200 characters)");
  }

  const documentId = uuidv4();
  return ingestContent(safeContent, adminId, {
    source: sourceName,
    type: "text",
    documentId,
  });
}

/**
 * Crawls a URL and ingests its text content into Pinecone for a specific admin.
 * @param adminId - Admin identifier for multi-tenant isolation
 * @param url - Public URL to crawl
 * @returns Object with chunk count, vector IDs, and page title
 */
export async function ingestURL(
  adminId: string,
  url: string
): Promise<{ chunks: number; vectorIds: string[]; title: string; content: string }> {
  // Fetch the URL
  const response = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KBCrawler/1.0)" },
    maxRedirects: 3,
    validateStatus: (status) => status < 400,
  });

  const contentType: string = response.headers["content-type"] ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error("URL does not return an HTML page");
  }

  // Parse HTML
  const $ = cheerio.load(response.data as string);
  $("script, style, nav, footer, header, aside, iframe, form, noscript").remove();

  const title = $("title").text().trim() || new URL(url).hostname;

  const rawText =
    $("main").text() ||
    $("article").text() ||
    $("section").text() ||
    $("body").text();

  const text = rawText.replace(/\s+/g, " ").trim();

  // Safeguards
  const safeText = validateContentSize(text, url);
  if (!validateMinContent(safeText)) {
    throw new Error(
      "Page has insufficient text content. It may require JavaScript to render or be behind a login wall."
    );
  }

  const documentId = uuidv4();
  const { chunks, vectorIds } = await ingestContent(
    safeText,
    adminId,
    { source: url, type: "url", documentId, title }
  );

  return { chunks, vectorIds, title, content: safeText };
}
