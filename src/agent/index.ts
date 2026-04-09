import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { retrieve } from "../ingestion/retriever.js";
import { getCurrentDatetime, searchWeb, createTicket, logMissedQuery } from "../tools/tools.js";
import { fetchTicketKeywords } from "../services/cpaas.js";
import AdminConfig from "../models/AdminConfig.js";
import AdminCredentials from "../models/AdminCredentials.js";
import Conversation from "../models/Conversation.js";
import UsageLog from "../models/UsageLog.js";
import { env } from "../config/env.js";

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) =>
      left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  adminId: Annotation<string | undefined>(),
  systemPrompt: Annotation<string>(),
});

type AgentStateType = (typeof AgentState)["State"];

export async function runAgent(adminId: string, message: string, threadId: string) {

  // ── Load conversation history ─────────────────────────────────────────────
  let conversation = await Conversation.findOne({ threadId, adminId });
  // Token-aware history trimming — approx 4 chars per token, 8000 token budget
  const TOKEN_BUDGET = 8000;
  const CHARS_PER_TOKEN = 4;
  const MAX_HISTORY_CHARS = TOKEN_BUDGET * CHARS_PER_TOKEN;

  const rawMessages = conversation
    ? conversation.messages
      .filter((m) => m.content && m.content.trim() !== "")
    : [];

  // Walk from newest to oldest, accumulate until budget exhausted
  let charCount = 0;
  const trimmed: typeof rawMessages = [];
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msgChars = rawMessages[i].content.length;
    if (charCount + msgChars > MAX_HISTORY_CHARS) break;
    trimmed.unshift(rawMessages[i]);
    charCount += msgChars;
  }

  const historyMessages: BaseMessage[] = trimmed.map((m) =>
    m.role === "human" ? new HumanMessage(m.content) : new AIMessage(m.content)
  );

  // ── Fetch admin config + credentials ─────────────────────────────────────
  const configDoc = await AdminConfig.findOne({ adminId });
  if (!configDoc) throw new Error(`Admin not found: ${adminId}`);
  const config = configDoc;

  const creds = await AdminCredentials.findOne({ adminId });

  // ── Build tools array ─────────────────────────────────────────────────────
  const toolsArray: any[] = [];

  if (config.tools.get_current_datetime === true) {
    toolsArray.push(getCurrentDatetime);
  }

  if (config.tools.search_web === true) {
    toolsArray.push(searchWeb);
  }

  if (config.tools.create_ticket === true) {
    toolsArray.push(createTicket);
  }
  // Always include log_missed_query — it is always active
  toolsArray.push(logMissedQuery);

  console.log(`[DEBUG] Admin: ${adminId}, Tools loaded:`, toolsArray.map((t) => t.name));

  // ── RAG retrieval ONCE before graph (not inside graph loop) ──────────────
  const kbContext = config.tools.search_knowledge_base
    ? await retrieve(message, adminId, config.kb.collectionName, config.kb.maxResults)
    : "";

  // ── Fetch ticket keywords if tool is enabled ──────────────────────────────
  const ticketKeywords: string[] =
    config.tools.create_ticket && creds
      ? await fetchTicketKeywords(creds.user_id, creds.token)
      : [];

  // ── LLM setup ────────────────────────────────────────────────────────────
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0,
    apiKey: env.GOOGLE_API_KEY,
  });
  const llmWithTools = toolsArray.length > 0 ? llm.bindTools(toolsArray) : llm;

  // ── LLM node — only node in graph, no separate retrieve node ─────────────
  async function llmNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const messages: BaseMessage[] = [];

    if (state.systemPrompt) {
      messages.push(new SystemMessage(state.systemPrompt));
    }

    messages.push(...state.messages);

    const response = await llmWithTools.invoke(messages);
    return { messages: [response] };
  }

  const toolNode = new ToolNode<{ messages: BaseMessage[] }>(toolsArray);

  const shouldContinue = (state: AgentStateType) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      "tool_calls" in lastMessage &&
      Array.isArray((lastMessage as any).tool_calls) &&
      (lastMessage as any).tool_calls.length > 0
    ) {
      return "tools" as const;
    }
    return END;
  };

  // ── Simple graph: START → llm ↔ tools → END ──────────────────────────────
  const graph = new StateGraph(AgentState)
    .addNode("llm", llmNode)
    .addNode("tools", toolNode)
    .addEdge(START, "llm")
    .addConditionalEdges("llm", shouldContinue, {
      tools: "tools",
      [END]: END,
    })
    .addEdge("tools", "llm");

  const compiledGraph = graph.compile();

  const keywordsLine = ticketKeywords.length > 0
    ? `\n\nAvailable ticket keywords (use exactly one when creating a ticket): ${ticketKeywords.join(", ")}`
    : "";

  const confirmLine = config.confirmBeforeTicket
    ? `\nBefore creating a ticket, ask: "Should I go ahead and raise a support ticket for this issue?" — only call create_ticket after user confirms. Never ask the user for priority, keywords, or any ticket fields — infer them from the conversation.`
    : `\nWhen requested, create tickets immediately without asking for confirmation.`;


  const escalationRule = config.tools.create_ticket
    ? `\n\nEscalation policy:
- ALWAYS try to resolve using the knowledge base and available tools first.
- If the knowledge base has no answer for a genuine support question, call log_missed_query ONCE (silently) before responding.
- Only create a support ticket if: (1) the user explicitly requests a ticket, OR (2) you have searched the KB, found nothing, AND the issue clearly requires human intervention (e.g. billing dispute, technical failure, complaint).
- NEVER offer to create a ticket for: gibberish, test messages, greetings, out-of-scope questions, or general questions you cannot answer.
- For gibberish or unclear messages: respond with "I'm sorry, I didn't understand that. Could you please rephrase your question?" — do NOT offer a ticket.`
    : `\n\nEscalation policy:
- If the knowledge base has no answer for a genuine support question, call log_missed_query ONCE (silently) before responding.
- For gibberish or unclear messages: respond with "I'm sorry, I didn't understand that. Could you please rephrase your question?" — do NOT log it as a missed query.`;


  const basePrompt = config.customSystemPrompt?.trim()
    ? config.customSystemPrompt.trim()
    : "You are a helpful assistant.";

  const kbRestrictionLine = config.kbOnlyMode
    ? `\n\nIMPORTANT: You MUST only answer questions using the knowledge base context provided above. If the answer is not found in the knowledge base context AND the question is a genuine support question, call log_missed_query silently then respond: "I'm sorry, I don't have information about that in my knowledge base." Do NOT use your general knowledge. Do NOT make up answers. Do NOT offer a ticket unless the user explicitly asks for one.`
    : "";

  const threadLine = `\nThe current conversation threadId (customer phone number) is: ${threadId}`;

  const languageLine = `\n\nIMPORTANT: Always detect the language of the user's message and respond in the SAME language. If the user writes in Hindi, respond in Hindi. If in Arabic, respond in Arabic. If in Spanish, respond in Spanish. Match the user's language exactly in every response.`;

  const systemPrompt = kbContext
    ? `${basePrompt}${threadLine}${languageLine}\n\nUse the following knowledge base context to answer the user's question.\nIf the context does not contain enough information, say so clearly.\n\n--- KNOWLEDGE BASE CONTEXT ---\n${kbContext}\n--- END CONTEXT ---\n\nAnswer directly and concisely. Do NOT call search tools if the context above is sufficient.${kbRestrictionLine}${keywordsLine}${confirmLine}${escalationRule}`
    : `${basePrompt}${threadLine}${languageLine}${kbRestrictionLine}${keywordsLine}${confirmLine}${escalationRule}`;


  // ── Invoke graph ──────────────────────────────────────────────────────────
  const agentStart = Date.now();
  const result = await compiledGraph.invoke(
    {
      messages: [...historyMessages, new HumanMessage(message)],
      adminId,
      systemPrompt,
    },
    { recursionLimit: 25, configurable: { adminId } }
  );
  const latencyMs = Date.now() - agentStart;

  // ── Extract final AI response text ────────────────────────────────────────
  let aiResponseText = "";
  const resultMessages: BaseMessage[] = result.messages ?? [];
  for (let i = resultMessages.length - 1; i >= 0; i--) {
    const msg = resultMessages[i];
    const isAI =
      msg instanceof AIMessage ||
      (typeof (msg as any)._getType === "function" &&
        (msg as any)._getType() === "ai");
    if (!isAI) continue;
    const hasToolCalls =
      "tool_calls" in (msg as any) &&
      Array.isArray((msg as any).tool_calls) &&
      (msg as any).tool_calls.length > 0;
    if (hasToolCalls) continue;
    if (typeof (msg as any).content === "string" && (msg as any).content.trim()) {
      aiResponseText = (msg as any).content.trim();
      break;
    }
  }

  // ── Fire-and-forget token usage logging ──────────────────────────────────
  {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    for (const msg of resultMessages) {
      const usage = (msg as any).usage_metadata;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        totalTokens += usage.total_tokens ?? 0;
      }
    }
    UsageLog.create({
      adminId,
      threadId,
      modelName: "gemini-2.5-flash",
      inputTokens,
      outputTokens,
      totalTokens,
      source: threadId.startsWith("admin-test") ? "test" : "whatsapp",
      latencyMs,
      status: "success",
    }).catch((err) => console.error("[UsageLog] Failed to save usage:", err));
  }

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  const now = new Date();
  if (!conversation) {
    conversation = new Conversation({ threadId, adminId, messages: [] });
  }
  conversation.messages.push(
    { role: "human", content: message, timestamp: now },
    { role: "ai", content: aiResponseText, timestamp: now }
  );
  await conversation.save();

  return result;
}
