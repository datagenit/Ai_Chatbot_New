import mongoose from "mongoose";

const missedQuerySchema = new mongoose.Schema(
  {
    adminId:  { type: String, required: true, index: true },
    threadId: { type: String, required: true },
    query:    { type: String, required: true },
    source:   { type: String, enum: ["whatsapp", "test"], default: "whatsapp" },
  },
  { timestamps: true }
);

const MissedQuery = mongoose.model("MissedQuery", missedQuerySchema);
export default MissedQuery;
