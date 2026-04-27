import mongoose, { Schema, Document } from "mongoose";

export interface IAdminConfig extends Document {
  adminId: string;
  tools: {
    get_current_datetime: boolean;
    search_knowledge_base: boolean;
    search_web: boolean;
    create_ticket: boolean;
  };
  kb: {
    maxResults: number;
  };
  conversationTtlDays: number;
  confirmBeforeTicket: boolean;
  customSystemPrompt: string;
  kbOnlyMode: boolean;
  createdAt: Date;
}

const AdminConfigSchema = new Schema<IAdminConfig>({
  adminId: {
    type: String,
    required: true,
    unique: true,
  },
  tools: {
    get_current_datetime: {
      type: Boolean,
      default: true,
    },
    search_knowledge_base: {
      type: Boolean,
      default: true,
    },
    search_web: {
      type: Boolean,
      default: false,
    },
    create_ticket: {
      type: Boolean,
      default: false,
    },
  },
  kb: {
    maxResults: {
      type: Number,
      default: 5,
    },
  },
  conversationTtlDays: {
    type: Number,
    default: 30,
    min: 1,
    max: 365,
  },
  confirmBeforeTicket: {
    type: Boolean,
    default: false,
  },
  customSystemPrompt: {
    type: String,
    default: "",
  },
  kbOnlyMode: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const AdminConfig = mongoose.model<IAdminConfig>("AdminConfig", AdminConfigSchema);

export default AdminConfig;
