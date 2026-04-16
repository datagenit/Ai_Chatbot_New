// MANUAL STEP REQUIRED: run this once in MongoDB Compass to drop the old bad index:
// db.workflowsessions.dropIndex("threadId_1")
import mongoose, { Schema, Document } from "mongoose";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IWorkflowSession extends Document {
  adminId: string;
  threadId: string;
  workflowId: string;
  currentStepId: string;
  collectedData: Map<string, string>;
  waitingForInput?: boolean;
  delayUntil?: Date | null;
  done: boolean;
  startedAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  expiresAt: Date | null;
  // ── V2 awaiting-state fields (optional, backward-compatible) ──────────────
  awaitingStepId?: string | null;
  awaitingType?: "send_menu" | "send_interactive" | "collect_input" | null;
  validReplyIds?: string[];
  validReplyLabels?: string[];
  promptText?: string;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const WorkflowSessionSchema = new Schema<IWorkflowSession>({
  adminId: { type: String, required: true, index: true },
  threadId: { type: String, required: true, index: true },
  workflowId: { type: String, required: true },
  currentStepId: { type: String, required: true },
  collectedData: { type: Map, of: String, default: {} },
  waitingForInput: { type: Boolean, default: false },
  delayUntil: { type: Date, default: null },
  done: { type: Boolean, default: false },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  // ── V2 awaiting-state fields ───────────────────────────────────────────────
  awaitingStepId: { type: String, default: null },
  awaitingType: {
    type: String,
    enum: ["send_menu", "send_interactive", "collect_input", null],
    default: null,
  },
  validReplyIds: { type: [String], default: [] },
  validReplyLabels: { type: [String], default: [] },
  promptText: { type: String, default: "" },
});

// TTL — auto-delete completed sessions after 30 days
WorkflowSessionSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { done: true },
  }
);

// Sparse index for expiry scheduler query
WorkflowSessionSchema.index({ expiresAt: 1, done: 1 });

const WorkflowSession = mongoose.model<IWorkflowSession>(
  "WorkflowSession",
  WorkflowSessionSchema
);

export default WorkflowSession;
