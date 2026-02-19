import { ChromaClient } from "chromadb";
import { DefaultEmbeddingFunction } from "chromadb";

const client = new ChromaClient({ path: "http://localhost:8000" });

/**
 * Retrieves relevant chunks from ChromaDB for a query.
 * @param query - Search query string
 * @param adminId - Admin identifier for multi-tenant isolation
 * @returns Top 5 most relevant chunks as a concatenated string
 */
export async function retrieve(query: string, adminId: string): Promise<string> {
  const collectionName = `admin_${adminId}`;

  try {
    const embeddingFunction = new DefaultEmbeddingFunction();
    const collection = await client.getCollection({
      name: collectionName,
      embeddingFunction,
    });

    // Query for top 5 results
    const results = await collection.query({
      queryTexts: [query],
      nResults: 5,
    });

    // Return documents[0].join("\n") as context string
    if (results.documents && results.documents.length > 0 && results.documents[0]) {
      const documents = results.documents[0].filter((doc): doc is string => doc !== null);
      return documents.join("\n");
    }

    return "";
  } catch (error) {
    // Collection doesn't exist, return empty string
    return "";
  }
}
