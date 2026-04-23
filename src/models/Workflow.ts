import mongoose, { Schema, Document } from "mongoose";

// ── Step sub-schema ────────────────────────────────────────────────────────────

const BranchSchema = new Schema(
  {
    label: { type: String },
    operator: {
      type: String,
      enum: ["equals", "contains", "exists", "not_equals", "not_contains"],
    },
    value: { type: String },
    nextStep: { type: String },
  },
  { _id: false }
);

const StepSchema = new Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "message",
        "collect_input",
        "api_call",
        "send_template",
        "delay",
        "condition",
        "send_interactive",
        "send_menu",
        "loop",
        "send_media",
        "ai_router",
      ],
      required: true,
    },
    nextStep: { type: String },

    // type: "message"
    message: { type: String },

    // type: "send_media"
    mediaType: { type: String, default: "image" },
    mediaUrl:  { type: String, default: "" },
    caption:   { type: String, default: "" },
    filename:  { type: String, default: "" },

    // type: "collect_input"
    inputKey: { type: String },
    inputPrompt: { type: String },
    prompt: { type: String },
    variable: { type: String },
    validOptions: [{ type: String }],
    saveResponseTo: { type: String },
    validation: {
      type: String,
      enum: ["text", "phone", "date", "email", "number", "regex"],
    },
    retryPrompt:  { type: String },
    maxRetries:   { type: Number, default: 3 },
    onMaxRetries: { type: String },

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
      mappings: [
        {
          variable: { type: String },
          path: { type: String },
        },
      ],
      onError: { type: String },
    },

    // type: "send_template"
    templateConfig: {
      wid: { type: Number },
      templateName: { type: String },
      bodyParams: { type: Map, of: String },
      mediaUrl: { type: String },
      onError: { type: String },
    },

    // type: "delay"
    delayMinutes: { type: Number },

    // type: "condition"
    condition: {
      variable: { type: String },
      // legacy single-branch fields (backward compat)
      operator: {
        type: String,
        enum: ["equals", "contains", "exists", "not_equals", "not_contains"],
      },
      value: { type: String },
      onTrue: { type: String },
      onFalse: { type: String },
      // multi-branch fields
      branches: [BranchSchema],
      defaultNextStep: { type: String },
      // fuzzy AI classification
      fuzzy: { type: Boolean, default: false },
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

    // type: "send_menu"
    menuConfig: {
      body: { type: String },
      buttonText: { type: String },
      sections: [
        {
          title: { type: String },
          rows: [
            {
              id: { type: String },
              title: { type: String },
              description: { type: String },
            },
          ],
        },
      ],
      dynamicRowsKey: { type: String },
      sectionTitle: { type: String },
    },

    // type: "loop"
    loopConfig: {
      targetStepId: { type: String },
      maxIterations: { type: Number },
      exitCondition: {
        variable: { type: String },
        operator: {
          type: String,
          enum: ["equals", "contains", "exists", "not_equals", "not_contains"],
        },
        value: { type: String },
      },
    },

    // type: "ai_router"
    aiRouterConfig: {
      systemPrompt: { type: String },
      routes: [
        {
          label: { type: String },
          nextStep: { type: String },
        },
      ],
      defaultNextStep: { type: String },
    },
  },
  { _id: false }
);

// ── Workflow interfaces ────────────────────────────────────────────────────────

export interface IConditionBranch {
  label?: string;
  operator?: "equals" | "contains" | "exists" | "not_equals" | "not_contains";
  value?: string;
  nextStep?: string;
}

export interface IWorkflowStep {
  id: string;
  type:
    | "message"
    | "collect_input"
    | "api_call"
    | "send_template"
    | "delay"
    | "condition"
    | "send_interactive"
    | "send_menu"
    | "loop"
    | "send_media"
    | "ai_router";
  nextStep?: string;
  message?: string;
  mediaType?: string;
  mediaUrl?: string;
  caption?: string;
  filename?: string;
  inputKey?: string;
  inputPrompt?: string;
  prompt?: string;
  variable?: string;
  validOptions?: string[];
  saveResponseTo?: string;
  validation?: "text" | "phone" | "date" | "email" | "number" | "regex";
  retryPrompt?:  string;
  maxRetries?:   number;
  onMaxRetries?: string;
  apiConfig?: {
    url?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH";
    headers?: Map<string, string>;
    body?: Map<string, string>;
    responseMapping?: Map<string, string>;
    mappings?: { variable: string; path: string }[];
    onError?: string;
  };
  templateConfig?: {
    wid?: number;
    templateName?: string;
    bodyParams?: Map<string, string>;
    mediaUrl?: string;
    onError?: string;
  };
  delayMinutes?: number;
  condition?: {
    variable?: string;
    // legacy
    operator?: "equals" | "contains" | "exists" | "not_equals" | "not_contains";
    value?: string;
    onTrue?: string;
    onFalse?: string;
    // multi-branch
    branches?: IConditionBranch[];
    defaultNextStep?: string;
    // fuzzy AI classification
    fuzzy?: boolean;
  };
  interactiveConfig?: {
    message: string;
    buttons: { id: string; title: string }[];
    nextStep: string;
  };
  menuConfig?: {
    body?: string;
    buttonText?: string;
    sections?: { title?: string; rows?: { id?: string; title?: string; description?: string }[] }[];
    dynamicRowsKey?: string;
    sectionTitle?: string;
  };
  loopConfig?: {
    targetStepId?: string;
    maxIterations?: number;
    exitCondition?: {
      variable?: string;
      operator?: "equals" | "contains" | "exists" | "not_equals" | "not_contains";
      value?: string;
    };
  };
  aiRouterConfig?: {
    systemPrompt?: string;
    routes: { label: string; nextStep: string }[];
    defaultNextStep: string;
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
  timeoutMinutes?: number;
  expiryMessage?: string;
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
  timeoutMinutes: { type: Number, default: 30 },
  expiryMessage: {
    type: String,
    default: "Your session has expired. Send 'hi' to start again.",
  },
});

const Workflow = mongoose.model<IWorkflow>("Workflow", WorkflowSchema);

export default Workflow;
