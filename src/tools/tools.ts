import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { retrieve } from "../ingestion/retriever.js";
import fetch from "node-fetch";
import AdminCredentials from "../models/AdminCredentials.js";
import { createTicketAPI } from "../services/cpaas.js";
import AdminConfig from "../models/AdminConfig.js";
import Conversation from "../models/Conversation.js";
import MissedQuery from "../models/MissedQuery.js";

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

export const createTicket = tool(
  async (
    { ticket_name, ticket_description, priority, keywords, remark, customer_number, customer_name, created_name },
    config
  ) => {
    try {
      console.log('[create_ticket] called with:', { ticket_name, ticket_description, priority, keywords, customer_number });
      const adminId = (config as any)?.configurable?.adminId;
      if (!adminId) return "Failed: adminId not available";
      const adminConfig = await AdminConfig.findOne({ adminId });

      if (adminConfig?.confirmBeforeTicket) {
        const conv = await Conversation.findOne({
          threadId: customer_number,
          adminId,
        });
        const recentMessages = conv?.messages.slice(-6) ?? [];
        const userConfirmed = recentMessages.some(
          (m) =>
            m.role === 'human' &&
            /\b(yes|yeah|sure|go ahead|please|confirm|ok|okay|do it|create it|raise it)\b/i.test(m.content)
        );

        if (!userConfirmed) {
          return "Confirmation required. Do NOT retry. Ask the customer: \"Should I go ahead and raise a support ticket for you?\" — wait for their confirmation first.";
        }
      }

      const creds = await AdminCredentials.findOne({ adminId });
      if (!creds) return "Failed: CPaaS credentials not configured";

      const result = await createTicketAPI({
        user_id: creds.user_id,
        token: creds.token,
        ticket_name,
        ticket_description,
        priority,
        keywords,
        remark: remark ?? "",
        customer_number,
        customer_name: customer_name || "Customer",
        created_name: created_name || "AIBOT",
      });
      console.log('[create_ticket] API result:', result);
      return result.success
        ? "Ticket created successfully. Inform the user the ticket has been raised."
        : `Ticket creation failed with error: ${result.message}. Do NOT retry. Inform the user of this error instead.`;
    } catch (err) {
      return `Failed: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
  {
    name: "create_ticket",
    description: `Create a support ticket in the CRM as a LAST RESORT only.
BEFORE calling this tool you MUST:
  1. Search the knowledge base first (if available)
  2. Attempt to answer the question using available context
  3. Only create a ticket if the issue CANNOT be resolved with available information

Do NOT create a ticket if:
  - The question can be answered from the knowledge base
  - The question is general and answerable without escalation
  - The user is just asking for information or help

DO create a ticket if:
  - The user explicitly says "raise a ticket", "create a ticket", "log a complaint"
  - The issue requires human intervention after KB search found no answer
  - The user is reporting a bug or technical failure that needs CRM tracking

Choose keywords ONLY from the list in the system prompt.
Set customer_number to the threadId of this conversation.
Priority defaults to "medium" if not specified.`,


    schema: z.object({
      ticket_name: z
        .string()
        .describe("Short title for the issue e.g. 'Billing Issue', 'Bug Report'"),
      ticket_description: z
        .string()
        .describe("Detailed description of the problem"),
      priority: z
        .enum(["low", "medium", "high"])
        .default("medium")
        .describe("Priority level — default to medium if unsure"),
      keywords: z
        .string()
        .describe("Pick the closest match from the keywords list in the system prompt. Default to 'Bug' if unsure"),
      remark: z
        .string()
        .optional()
        .default("")
        .describe("Any extra notes — leave empty if none"),
      customer_number: z
        .string()
        .default("unknown")
        .describe("The customer's phone number from the conversation threadId"),
      customer_name: z
        .string()
        .optional()
        .default("Customer")
        .describe("Customer's name if mentioned in the conversation, otherwise 'Customer'"),
      created_name: z
        .string()
        .optional()
        .default("AIBOT")
        .describe("Name of the person who has created this ticket for the customer"),
    }),

  }
);

export const logMissedQuery = tool(
  async ({ query, threadId }, config) => {
    try {
      const adminId = (config as any)?.configurable?.adminId;
      if (!adminId) return "logged";

      await MissedQuery.create({
        adminId,
        threadId,
        query,
        source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
      });

      return "logged";
    } catch {
      return "logged";
    }
  },
  {
    name: "log_missed_query",
    description: `Silently log a user query that could not be answered from the knowledge base or available tools. 
Call this tool ONCE when:
  - The knowledge base has no relevant information for the user's question
  - The question is a genuine support/product/service question (not gibberish, greetings, or off-topic messages)
Do NOT call this for: gibberish, test messages, greetings, or questions you can answer.
This tool returns nothing visible to the user — your response to the user should proceed normally after calling it.`,
    schema: z.object({
      query: z.string().describe("The exact user question that could not be answered"),
      threadId: z.string().describe("The conversation threadId"),
    }),
  }
);

export const tools = [getCurrentDatetime, searchKnowledgeBase, searchWeb, createTicket, logMissedQuery];

// Export individual tools for dynamic loading
export { getCurrentDatetime, searchKnowledgeBase, searchWeb };

