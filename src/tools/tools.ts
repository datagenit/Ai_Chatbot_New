import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { retrieve } from "../ingestion/retriever.js";
import fetch from "node-fetch";

const getCurrentDatetime = tool(
  async () => {
    return new Date().toISOString();
  },
  {
    name: "get_current_datetime",
    description: "Get the current date and time as an ISO string.",
    schema: z.object({}),
  }
);

const searchKnowledgeBase = tool(
  async ({ query, adminId }) => {
    return retrieve(query, adminId);
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the internal knowledge base for the given admin and return relevant context.",
    schema: z.object({
      query: z.string().describe("Natural language search query."),
      adminId: z.string().describe("Admin identifier for multi-tenant isolation."),
    }),
  }
);

const searchWeb = tool(
  async ({ query }) => {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`DuckDuckGo API request failed with ${response.status}`);
    }

    const data: any = await response.json();
    const results: string[] = [];

    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const topic of topics) {
      if (typeof topic.Text === "string") {
        results.push(topic.Text);
      }
      if (Array.isArray(topic.Topics)) {
        for (const sub of topic.Topics) {
          if (typeof sub.Text === "string") {
            results.push(sub.Text);
          }
        }
      }
      if (results.length >= 3) break;
    }

    if (!results.length && typeof data.AbstractText === "string") {
      results.push(data.AbstractText);
    }

    return results.slice(0, 3).join("\n");
  },
  {
    name: "search_web",
    description:
      "Search the web for up-to-date information using DuckDuckGo and return a short summary of the top results.",
    schema: z.object({
      query: z.string().describe("Search query for the web."),
    }),
  }
);

export const tools = [getCurrentDatetime, searchKnowledgeBase, searchWeb];

