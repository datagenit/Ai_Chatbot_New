import mongoose from "mongoose";

const missedQuerySchema = new mongoose.Schema(
  {
    adminId:             { type: String, required: true, index: true },
    threadId:            { type: String, required: true },
    query:               { type: String, required: true },
    source:              { type: String, enum: ["whatsapp", "test"], default: "whatsapp" },
    count:               { type: Number, default: 1 },
    status:              { type: String, enum: ["open", "dismissed", "added_to_kb"], default: "open", index: true },
    embeddingVector:     { type: [Number], default: [] },
    suggestedAnswer:     { type: String, default: "" },
    lastSeenAt:          { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Compound index for fast dedup queries
missedQuerySchema.index({ adminId: 1, status: 1 });

const MissedQuery = mongoose.model("MissedQuery", missedQuerySchema);
export default MissedQuery;
