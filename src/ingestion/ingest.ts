import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { ChromaClient } from "chromadb";
import { DefaultEmbeddingFunction } from "chromadb";

const client = new ChromaClient({ path: "http://localhost:8000" });

/**
 * Ingests a PDF file into ChromaDB for a specific admin.
 * @param filePath - Path to the PDF file
 * @param adminId - Admin identifier for multi-tenant isolation
 * @returns Number of chunks stored
 */
export async function ingest(filePath: string, adminId: string): Promise<number> {
  // Load PDF
  const loader = new PDFLoader(filePath);
  const documents = await loader.load();

  // Split into chunks
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks = await textSplitter.splitDocuments(documents);

  const collectionName = `admin_${adminId}`;
  const embeddingFunction = new DefaultEmbeddingFunction();

  // Get or create collection
  let collection;
  try {
    collection = await client.getCollection({
      name: collectionName,
      embeddingFunction,
    });
  } catch {
    // Collection doesn't exist, create it
    collection = await client.createCollection({
      name: collectionName,
      embeddingFunction,
    });
  }

  // Prepare data for ChromaDB with simple sequential IDs
  const ids = chunks.map((_, index) => `doc_${index}`);
  const texts = chunks.map((chunk) => chunk.pageContent);
  const metadatas = chunks.map((chunk) => ({
    source: filePath,
    page: chunk.metadata.pageNumber ?? 0,
  }));

  // Add chunks to collection
  await collection.add({
    ids,
    documents: texts,
    metadatas,
  });

  return chunks.length;
}
