import mongoose, { Schema, Document } from "mongoose";

// ── Step sub-schema ────────────────────────────────────────────────────────────

const StepSchema = new Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["message", "collect_input", "api_call", "send_template", "delay", "condition", "send_interactive"],
      required: true,
    },
    nextStep: { type: String },

    // type: "message"
    message: { type: String },

    // type: "collect_input"
    inputKey: { type: String },
    inputPrompt: { type: String },
    validation: {
      type: String,
      enum: ["text", "phone", "date", "email"],
    },

    // type: "api_call"
    apiConfig: {
      url: { type: String },
      method: {
        type: String,
        enum: ["GET", "POST", "PUT", "PATCH"],
      },
      headers: { type: Map, of: String },
      body: { type: Map, of: String },
      responseMapping: { type: Map, of: String },
    },

    // type: "send_template"
    templateConfig: {
      wid: { type: Number },
      templateName: { type: String },
      bodyParams: { type: Map, of: String },
      mediaUrl: { type: String },
    },

    // type: "delay"
    delayMinutes: { type: Number },

    // type: "condition"
    condition: {
      variable: { type: String },
      operator: {
        type: String,
        enum: ["equals", "contains", "exists"],
      },
      value: { type: String },
      onTrue: { type: String },
      onFalse: { type: String },
    },
    // type: "send_interactive"
    interactiveConfig: {
      message: { type: String },
      buttons: [
        {
          id: { type: String },
          title: { type: String },
        },
      ],
      nextStep: { type: String },
    },

  },
  { _id: false }
);

// ── Workflow interface ─────────────────────────────────────────────────────────

export interface IWorkflowStep {
  id: string;
  type: "message" | "collect_input" | "api_call" | "send_template" | "delay" | "condition" | "send_interactive";
  nextStep?: string;
  message?: string;
  inputKey?: string;
  inputPrompt?: string;
  validation?: "text" | "phone" | "date" | "email";
  apiConfig?: {
    url?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH";
    headers?: Map<string, string>;
    body?: Map<string, string>;
    responseMapping?: Map<string, string>;
  };
  templateConfig?: {
    wid?: number;
    templateName?: string;
    bodyParams?: Map<string, string>;
    mediaUrl?: string;
  };
  delayMinutes?: number;
  condition?: {
    variable?: string;
    operator?: "equals" | "contains" | "exists";
    value?: string;
    onTrue?: string;
    onFalse?: string;
  };
  interactiveConfig?: {
    message: string;
    buttons: { id: string; title: string }[];
    nextStep: string;
  };

}

export interface IWorkflow extends Document {
  adminId: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: {
    type: "keyword" | "intent" | "qr" | "template_reply";
    keywords: string[];
  };
  entryStepId: string;
  steps: IWorkflowStep[];
  createdAt: Date;
}

// ── Workflow schema ────────────────────────────────────────────────────────────

const WorkflowSchema = new Schema<IWorkflow>({
  adminId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  enabled: { type: Boolean, default: true },
  trigger: {
    type: {
      type: String,
      enum: ["keyword", "intent", "qr", "template_reply"],
      required: true,
    },
    keywords: [{ type: String }],
  },
  entryStepId: { type: String, required: true },
  steps: [StepSchema],
  createdAt: { type: Date, default: Date.now },
});

const Workflow = mongoose.model<IWorkflow>("Workflow", WorkflowSchema);

export default Workflow;
