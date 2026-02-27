import mongoose, { Document, Schema } from "mongoose";

export interface IUsageLog extends Document {
  adminId: string;
  threadId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "whatsapp" | "test";
  createdAt: Date;
  latencyMs?: number;
  status?: "success" | "error";
}

const UsageLogSchema = new Schema<IUsageLog>(
  {
    adminId: { type: String, required: true, index: true },
    threadId: { type: String, required: true },
    modelName: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ["whatsapp", "test"],
      default: "whatsapp",
    },
    createdAt: { type: Date, default: Date.now, index: true },
    latencyMs: { type: Number },
    status: { type: String, enum: ["success", "error"], default: "success" },
  },
  { timestamps: false }
);

UsageLogSchema.index({ adminId: 1, createdAt: -1 });

export default mongoose.model<IUsageLog>("UsageLog", UsageLogSchema);
