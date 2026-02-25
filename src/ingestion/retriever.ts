// src/ingestion/retriever.ts
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { HuggingFaceTransformersEmbeddings } from 
"@langchain/community/embeddings/huggingface_transformers";
import { env } from "../config/env.js";

const pinecone = new PineconeClient({ apiKey: env.PINECONE_API_KEY });

const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2", 
});

/**
 * Retrieves relevant chunks from Pinecone for a query.
 * @param query - Search query string
 * @param adminId - Admin identifier for multi-tenant isolation
 * @param collectionName - Ignored (kept for signature compatibility — namespace is always kb_{adminId})
 * @param maxResults - Optional max results (defaults to 5)
 * @returns Relevant chunks as a concatenated string
 */
export async function retrieve(
  query: string,
  adminId: string,
  collectionName?: string, // retained for drop-in compatibility, unused
  maxResults: number = 5
): Promise<string> {
  const namespace = `kb_${adminId}`;

  try {
    const pineconeIndex = pinecone.Index(env.PINECONE_INDEX_NAME);

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex,
      namespace,
    });

    const results = await vectorStore.similaritySearch(query, maxResults);

    if (!results.length) return "";

    return results.map((doc) => doc.pageContent).join("\n");
  } catch (error) {
    // Namespace doesn't exist or query failed — return empty string
    // to match original ChromaDB silent-fail behaviour
    return "";
  }
}
export async function deleteVectors(adminId: string, vectorIds: string[]): Promise<void> {
  const namespace = `kb_${adminId}`;
  const pineconeIndex = pinecone.Index(env.PINECONE_INDEX_NAME);
  const namespacedIndex = pineconeIndex.namespace(namespace);
  await namespacedIndex.deleteMany(vectorIds);
  console.log(`[Pinecone] Deleted ${vectorIds.length} vectors from namespace: ${namespace}`);
}

export async function ensureIndex(): Promise<void> {
  const existingIndexes = await pinecone.listIndexes();
  const names = existingIndexes.indexes?.map((i) => i.name) ?? [];

  if (names.includes(env.PINECONE_INDEX_NAME)) {
    console.log(`[Pinecone] Index "${env.PINECONE_INDEX_NAME}" already exists.`);
    return;
  }

  console.log(`[Pinecone] Creating index "${env.PINECONE_INDEX_NAME}"...`);

  await pinecone.createIndex({
    name: env.PINECONE_INDEX_NAME,
    dimension: 384,          // must match all-MiniLM-L6-v2
    metric: "cosine",
    spec: {
      serverless: {
        cloud: "aws",        // or "gcp" / "azure"
        region: "us-east-1", // pick your nearest region
      },
    },
  });

  // Wait for index to be ready before proceeding
  await pinecone.describeIndex(env.PINECONE_INDEX_NAME);
  console.log(`[Pinecone] Index "${env.PINECONE_INDEX_NAME}" ready.`);
}