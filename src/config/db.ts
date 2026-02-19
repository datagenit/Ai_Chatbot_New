import { ChromaClient } from "chromadb";

let chromaClient: ChromaClient | null = null;

/**
 * Get or create a ChromaDB client.
 * Optional env: CHROMA_HOST (default localhost), CHROMA_PORT (default 8000), CHROMA_SSL (default false).
 */
export function getChromaClient(): ChromaClient {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      path: process.env.CHROMA_URL ?? "http://localhost:8000",
    });
  }
  return chromaClient;
}
