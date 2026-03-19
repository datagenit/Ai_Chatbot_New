import Workflow from "../models/Workflow.js";

export async function matchWorkflowTrigger(
  adminId: string,
  message: string
): Promise<{ workflowId: string } | null> {
  try {
    const workflows = await Workflow.find({ adminId, enabled: true });
    const lower = message.toLowerCase();

    for (const wf of workflows) {
      if (wf.trigger.type === "keyword") {
        const keywords = wf.trigger.keywords ?? [];
        const matched = keywords.some((kw) => lower.includes(kw.toLowerCase()));
        if (matched) {
          return { workflowId: wf._id.toString() };
        }
      }
    }

    return null;
  } catch (err) {
    console.error(
      "[TriggerMatcher] matchWorkflowTrigger error:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
