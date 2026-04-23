# WhatsApp Chatbot Platform

## Stack
Node.js, TypeScript, Express, MongoDB/Mongoose, LangChain/LangGraph, Gemini 2.5 Flash, WhatsApp CPaaS

## Key Files
- src/routes/index.ts → /api/chat (priority chain: delay→activeSession→triggerMatch→automations→agent)
- src/agent/index.ts → runAgent() returns full LangGraph result, saves to Conversation internally
- src/workflows/engine.ts → runWorkflow() returns { text, preview }
- src/automations/engine.ts → runAutomations() returns { matched: boolean }
- src/models/Conversation.ts → { threadId, adminId, messages: [{role, content, timestamp}] }
- src/models/WorkflowSession.ts → { currentStepId, waitingForInput, collectedData, done, awaitingStepId, awaitingType, validReplyIds, validReplyLabels, promptText }
- src/models/Workflow.ts → { steps: IWorkflowStep[], entryStepId, trigger }
- src/middleware/auth.ts → JWT auth + IP bypass for internal server (reads user.parent_id from body)
- src/middleware/auth.ts → JWT auth + IP bypass (INTERNAL_SERVER_IP env var → reads adminId from req.body.user.parent_id)

## Conventions
- All LLM calls use ChatGoogleGenerativeAI
- runWorkflow returns { text, preview } — never sends res directly
- WorkflowSession V2 awaiting fields: awaitingStepId, awaitingType, validReplyIds, validReplyLabels, promptText
- saveToConversation() helper exists in src/routes/index.ts (added — saves human+AI to Conversation)
- Test threads: threadId starts with "admin-test"
- TTL: non-test conversations expire per admin config (default 30 days)
- INTERNAL_SERVER_IP env var → bypasses JWT, uses req.body.user.parent_id as adminId
- ai_router step type → classifies lastMessage via Gemini, routes to matched nextStep, no message sent
- IP bypass: internal server requests skip JWT, adminId = req.body.user.parent_id
- ai_router step: classifies lastMessage via gemini-2.0-flash, routes to matched nextStep, no message sent, no waitingForInput

## Step Types
message, send_interactive, send_menu, collect_input, condition, api_call, delay, assign_agent, ai_router

## Do Not Touch
- Rate limiters, sanitize middleware, auth middleware
- WorkflowSession schema fields
- Token usage logging in runAgent
- History loading (read) at top of runAgent