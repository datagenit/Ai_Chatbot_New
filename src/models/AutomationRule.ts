import mongoose, { Schema, Document } from "mongoose";

export interface IAutomationRule extends Document {
  adminId: string;
  name: string;
  enabled: boolean;
  trigger: {
    type: "keyword" | "sentiment";
    keywords?: string[];
    sentiment?: "positive" | "negative" | "neutral";
  };
  action: {
    type: "assign_agent" | "assign_label";
    value: string;
  };
  createdAt: Date;
}

const AutomationRuleSchema = new Schema<IAutomationRule>({
  adminId: {
    type: String,
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  trigger: {
    type: {
      type: String,
      enum: ["keyword", "sentiment"],
      required: true,
    },
    keywords: {
      type: [String],
      default: undefined,
    },
    sentiment: {
      type: String,
      enum: ["positive", "negative", "neutral"],
      default: undefined,
    },
  },
  action: {
    type: {
      type: String,
      enum: ["assign_agent", "assign_label"],
      required: true,
    },
    value: {
      type: String,
      required: true,
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const AutomationRule = mongoose.model<IAutomationRule>(
  "AutomationRule",
  AutomationRuleSchema
);

export default AutomationRule;
