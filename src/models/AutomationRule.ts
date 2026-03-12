import mongoose, { Schema, Document } from "mongoose";

export interface IAutomationRule extends Document {
  adminId: string;
  name: string;
  enabled: boolean;
  ruleType: "automation" | "trigger_template";
  trigger?: {
    type: "keyword" | "sentiment";
    keywords?: string[];
    sentiment?: "positive" | "negative" | "neutral";
  };
  action?: {
    type: "assign_agent" | "assign_label";
    value: string;
  };
  triggerConfig?: {
    triggerType: "intent" | "stage" | "no_reply" | "fallback";
    keywords: string[];
    confidenceThreshold: number;
    stage: string;
    waitMinutes: number;
    cooldownHours: number;
    template?: {
      wid: number;
      templateName?: string;
      bodyParams?: Map<string, string>;
      headerParams?: Map<string, string>;
      mediaUrl?: string;
    };
    lastFired?: Map<string, Date>;
  };
  createdAt: Date;
}

const TemplateSchema = new Schema(
  {
    wid: { type: Number, required: true },
    templateName: { type: String },
    bodyParams: { type: Map, of: String, default: {} },
    headerParams: { type: Map, of: String, default: {} },
    mediaUrl: { type: String },
  },
  { _id: false }
);

const TriggerConfigSchema = new Schema(
  {
    triggerType: {
      type: String,
      enum: ["intent", "stage", "no_reply", "fallback"],
      required: true,
    },
    keywords: { type: [String], default: [] },
    confidenceThreshold: { type: Number, default: 75 },
    stage: { type: String, default: "" },
    waitMinutes: { type: Number, default: 30 },
    cooldownHours: { type: Number, default: 24 },
    template: { type: TemplateSchema },
    lastFired: { type: Map, of: Date, default: {} },
  },
  { _id: false }
);

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
  ruleType: {
    type: String,
    enum: ["automation", "trigger_template"],
    default: "automation",
  },
  trigger: {
    type: {
      type: String,
      enum: ["keyword", "sentiment"],
      // required removed — trigger is optional for trigger_template docs
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
      // required removed — action is optional for trigger_template docs
    },
    value: {
      type: String,
      // required removed — action is optional for trigger_template docs
    },
  },
  triggerConfig: { type: TriggerConfigSchema },
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
