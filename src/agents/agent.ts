import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatGroq } from "@langchain/groq";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { retrieve } from "../ingestion/retriever.js";
import { tools } from "../tools/tools.js";

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) =>
      left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  adminId: Annotation<string | undefined>(),
  context: Annotation<string>(),
});

type AgentStateType = (typeof AgentState)["State"];

function createAgent(groqApiKey: string) {
  const llm = new ChatGroq({
    apiKey: groqApiKey,
    model: "llama-3.3-70b-versatile",
    temperature: 0,
  });
  const llmWithTools = llm.bindTools(tools);

  async function retrieveNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (!state.adminId) {
      return { context: "" };
    }

    // Get the last user message for retrieval
    const lastMessage = state.messages[state.messages.length - 1];
    const query =
      lastMessage && "content" in lastMessage
        ? String(lastMessage.content)
        : "";

    if (!query) {
      return { context: "" };
    }

    const context = await retrieve(query, state.adminId);
    return { context };
  }

  async function llmNode(
    state: AgentStateType
  ): Promise<Partial<AgentStateType>> {
    // Build messages with context if available
    const messages: BaseMessage[] = [];

    // Add system message with context if adminId is provided
    if (state.adminId && state.context) {
      messages.push(
        new SystemMessage(`Use this context to answer: ${state.context}`)
      );
    }

    // Add existing conversation messages
    messages.push(...state.messages);

    const response = await llmWithTools.invoke(messages);

    // Preserve full AIMessage (including tool_calls and final content)
    return {
      messages: [response],
    };
  }

  const toolNode = new ToolNode<{ messages: BaseMessage[] }>(tools);

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

  const graph = new StateGraph(AgentState)
    .addNode("retrieve", retrieveNode)
    .addNode("llm", llmNode)
    .addNode("tools", toolNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "llm")
    .addConditionalEdges("llm", shouldContinue)
    .addEdge("tools", "llm");

  return graph.compile();
}

export { createAgent, type AgentStateType };
