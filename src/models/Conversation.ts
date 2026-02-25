import mongoose, { Schema, Document } from "mongoose";
import AdminConfig from "./AdminConfig.js";

export interface IMessage {
  role: "human" | "ai";
  content: string;
  timestamp: Date;
}

export interface IConversation extends Document {
  threadId: string;
  adminId: string;
  messages: IMessage[];
  updatedAt: Date;
  expiresAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: {
      type: String,
      enum: ["human", "ai"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>({
  threadId: {
    type: String,
    required: true,
    index: true,
  },
  adminId: {
    type: String,
    required: true,
    index: true,
  },
  messages: {
    type: [MessageSchema],
    default: [],
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: { type: Date, index: { expires: 0 } },
});

// Compound index for efficient per-thread-per-admin lookups
ConversationSchema.index({ threadId: 1, adminId: 1 });

// Trim the messages array to the last MAX_MESSAGES entries before every save
ConversationSchema.pre("save", async function () {
  this.updatedAt = new Date();

  // Auto-expire WhatsApp threads (phone number threadIds) after 30 days
  // Test threads (starting with "admin-test") never expire
  if (!this.threadId.startsWith("admin-test")) {
    // Fetch TTL from admin config — fallback to 30 days if not set
    const config = await AdminConfig.findOne({ adminId: this.adminId });
    const ttlDays = config?.conversationTtlDays ?? 30;
    this.expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }
});
const Conversation = mongoose.model<IConversation>("Conversation", ConversationSchema);

export default Conversation;
