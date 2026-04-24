# WhatsApp Chatbot Platform

## Stack
Node.js, TypeScript, Express, MongoDB/Mongoose, LangChain/LangGraph, Gemini 2.5 Flash, WhatsApp CPaaS

## Key Files
- src/routes/index.ts → /api/chat (priority chain: delay→activeSession→triggerMatch→automations→agent)
- src/agent/index.ts → runAgent() returns full LangGraph result, saves to Conversation internally
- src/workflows/engine.ts → runWorkflow() returns { text, preview }
- src/automations/engine.ts → runAutomations() returns { matched: boolean }
- src/models/Conversation.ts → { threadId, adminId, messages: [{role, content, timestamp}] }
- src/models/WorkflowSession.ts → { currentStepId, waitingForInput, collectedData, done, awaitingStepId, awaitingType, validReplyIds, validReplyLabels, promptText, delayUntil, lastActivityAt, expiresAt }
- src/models/Workflow.ts → { steps: IWorkflowStep[], entryStepId, trigger, timeoutMinutes, expiryMessage }
- src/models/AdminConfig.ts → { tools, kb, customSystemPrompt, kbOnlyMode, confirmBeforeTicket, conversationTtlDays }
- src/models/GlobalVariable.ts → { adminId, key, value } — injected into workflow data (lowest priority)
- src/models/ExecutionLog.ts → per-step trace for every workflow run
- src/models/MissedQuery.ts → queries agent couldn't answer from KB
- src/middleware/auth.ts → JWT auth + IP bypass (INTERNAL_SERVER_IP env var → reads adminId from req.body.user.parent_id)
- src/services/cpaas.ts → sendTextMessage, sendTextWithButtons, sendListMessage, sendMediaMessage, sendTemplate, assignAgent, addLabel, getCredentials, fetchTicketKeywords
- src/tools/tools.ts → getCurrentDatetime, searchWeb, createTicket, logMissedQuery (always active)
- src/workflows/triggerMatcher.ts → matchWorkflowTrigger(adminId, input)
- src/workflows/delayScheduler.ts → isThreadDelayed(threadId)
- src/ingestion/retriever.ts → retrieve(message, adminId, collectionName, maxResults)

## Conventions
- All LLM calls use ChatGoogleGenerativeAI
- runWorkflow returns { text, preview } — never sends res directly
- runAgent saves to Conversation internally — do NOT save again at route level
- WorkflowSession V2 awaiting fields: awaitingStepId, awaitingType, validReplyIds, validReplyLabels, promptText
- Test threads: threadId starts with "admin-test" → UsageLog source = "test"
- TTL: non-test conversations expire per admin config (default 30 days)
- INTERNAL_SERVER_IP env var → bypasses JWT, uses req.body.user.parent_id as adminId
- ai_router step type → classifies lastMessage via gemini-2.0-flash, routes to matched nextStep, no message sent, continueLoop=true
- IP bypass: internal server requests skip JWT, adminId = req.body.user.parent_id
- collectedData internal keys: __retries_<stepId>, __loop_<stepId>_count, __menu_reply_<stepId>, __menu_reply_<stepId>_title
- Global variables: loaded once per runWorkflow call, lowest priority (collectedData wins on collision)
- Condition fallthrough guard: no branch + no defaultNextStep → sends workflow.expiryMessage, session.done = true

## Step Types
message, send_interactive, send_menu, collect_input, condition, api_call, send_template, send_media, delay, assign_agent, assign_label, loop, ai_router

## Workflow Engine Patterns
- Phase 1/2: every interactive step sends prompt (phase 1) then processes reply (phase 2)
- V2/legacy self-heal: repairs awaitingStepId/awaitingType from step config without resending
- Stale button detection: detectStaleButtonReply() — title match then id match, reverse step order
- AI Intent Guard: isOffTopicMessage() (gemini-2.0-flash, 5 tokens) → handleOffTopicReply() calls runAgent with workflow context, sends RAG answer + re-prompts via CPaaS
- Retry logic (collect_input): __retries_<stepId> counter, maxRetries=3, onMaxRetries → stepId or done
- Condition fuzzy: cond.fuzzy=true → classifyWithAI() via gemini-2.0-flash
- Execution logging: logStepEntry/logStepExit per step, fire-and-forget, never throws
- api_call: supports responseMapping (Map) + mappings (lodash _.get array), onError stepId

## Agent Patterns
- LangGraph: START → llm ↔ tools → END, recursionLimit=25
- History: token-aware trim 8000 token budget (~4 chars/token), newest→oldest
- RAG: retrieve() once before graph, injected into system prompt
- Tools: conditionally enabled per AdminConfig.tools; logMissedQuery always included
- escalationRule: try KB first; log_missed_query silently if no answer; ticket only if user explicitly asks or genuine unresolvable issue; never for gibberish/greetings

## Do Not Touch
- Rate limiters, sanitize middleware, auth middleware
- WorkflowSession schema fields
- Token usage logging in runAgent
- History loading (read) at top of runAgent
