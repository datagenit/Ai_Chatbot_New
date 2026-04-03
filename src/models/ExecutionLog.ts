import mongoose, { Schema, Document } from "mongoose";

// ── Step sub-document ─────────────────────────────────────────────────────────

export interface IExecutionStep {
  stepId:     string;
  stepType:   string;
  enteredAt:  Date;
  exitedAt:   Date | null;
  status:     "completed" | "waiting" | "error";
  input:      string | null;
  output:     string | null;
  error:      string | null;
  nextStepId: string | null;
  retryCount: number;
}

// ── Top-level document ────────────────────────────────────────────────────────

export interface IExecutionLog extends Document {
  adminId:      string;
  workflowId:   string;
  workflowName: string;
  sessionId:    string;
  threadId:     string;
  startedAt:    Date;
  completedAt:  Date | null;
  status:       "running" | "completed" | "expired" | "error";
  steps:        IExecutionStep[];
}

// ── Sub-schema ────────────────────────────────────────────────────────────────

const ExecutionStepSchema = new Schema<IExecutionStep>(
  {
    stepId:     { type: String },
    stepType:   { type: String },
    enteredAt:  { type: Date },
    exitedAt:   { type: Date, default: null },
    status:     { type: String, enum: ["completed", "waiting", "error"] },
    input:      { type: String, default: null },
    output:     { type: String, default: null },
    error:      { type: String, default: null },
    nextStepId: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Top-level schema ──────────────────────────────────────────────────────────

const ExecutionLogSchema = new Schema<IExecutionLog>({
  adminId:      { type: String, required: true, index: true },
  workflowId:   { type: String, required: true, index: true },
  workflowName: { type: String },
  sessionId:    { type: String, required: true },
  threadId:     { type: String, required: true, index: true },
  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date, default: null },
  status: {
    type: String,
    enum: ["running", "completed", "expired", "error"],
    default: "running",
  },
  steps: [ExecutionStepSchema],
});

// Composite index for the "runs list" query (by admin + workflow, newest first)
ExecutionLogSchema.index({ adminId: 1, workflowId: 1, startedAt: -1 });

// Fast lookup by sessionId
ExecutionLogSchema.index({ sessionId: 1 });

// TTL — auto-delete logs older than 90 days
ExecutionLogSchema.index(
  { startedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

const ExecutionLog = mongoose.model<IExecutionLog>("ExecutionLog", ExecutionLogSchema);

export default ExecutionLog;
