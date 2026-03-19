import mongoose, { Schema, Document } from "mongoose";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IWorkflowSession extends Document {
  adminId: string;
  threadId: string;
  workflowId: string;
  currentStepId: string;
  collectedData: Map<string, string>;
  waitingForInput: boolean;
  delayUntil?: Date | null;
  done: boolean;
  startedAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const WorkflowSessionSchema = new Schema<IWorkflowSession>({
  adminId: { type: String, required: true, index: true },
  threadId: { type: String, required: true, unique: true, index: true },
  workflowId: { type: String, required: true },
  currentStepId: { type: String, required: true },
  collectedData: { type: Map, of: String, default: {} },
  waitingForInput: { type: Boolean, default: false },
  delayUntil: { type: Date, default: null },
  done: { type: Boolean, default: false },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const WorkflowSession = mongoose.model<IWorkflowSession>(
  "WorkflowSession",
  WorkflowSessionSchema
);

export default WorkflowSession;
