// src/ingestion/ingest.ts
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env.js";

const pinecone = new PineconeClient({ apiKey: env.PINECONE_API_KEY });

const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2",
});

/**
 * Ingests a PDF file into Pinecone for a specific admin.
 * @param filePath - Path to the PDF file
 * @param adminId - Admin identifier for multi-tenant isolation
 * @returns Object with chunk count and vector IDs stored in Pinecone
 */
export async function ingest(
  filePath: string,
  adminId: string
): Promise<{ chunks: number; vectorIds: string[] }> {
  // Load PDF
  const loader = new PDFLoader(filePath);
  const documents = await loader.load();

  // Split into chunks
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks = await textSplitter.splitDocuments(documents);

  // Tag metadata (mirrors your original structure)
  const taggedChunks = chunks.map((chunk) => ({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      adminId,
      source: filePath,
      page: chunk.metadata.pageNumber ?? 0,
    },
  }));

  const namespace = `kb_${adminId}`;
  const pineconeIndex = pinecone.Index(env.PINECONE_INDEX_NAME);
  const vectorIds = chunks.map(() => uuidv4());

  // Upsert into admin's namespace with deterministic IDs for later deletion
  await PineconeStore.fromDocuments(taggedChunks, embeddings, {
    pineconeIndex,
    namespace,
    ids: vectorIds,
  });

  return { chunks: chunks.length, vectorIds };
}
