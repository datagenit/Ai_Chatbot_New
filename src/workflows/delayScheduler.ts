import WorkflowSession from "../models/WorkflowSession.js";
import { runWorkflow } from "./engine.js";
import { getCredentials, sendTextMessage } from "../services/cpaas.js";

export async function isThreadDelayed(threadId: string): Promise<boolean> {
  try {
    const session = await WorkflowSession.findOne({ threadId, done: false });
    if (!session) return false;
    if (session.delayUntil && new Date() < session.delayUntil) return true;
    return false;
  } catch (err) {
    console.error(
      "[DelayScheduler] isThreadDelayed error:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export async function resumeDelayedWorkflows(): Promise<void> {
  try {
    const now = new Date();
    const sessions = await WorkflowSession.find({
      done: false,
      delayUntil: { $ne: null, $lte: now },
      waitingForInput: false,
    });
    console.log(`[DelayScheduler] found ${sessions.length} sessions to resume`);
    for (const session of sessions) {
      session.delayUntil = null;           // ← null, not undefined
      session.markModified('delayUntil');  // ← force Mongoose to persist it
      await session.save();

      const reply = await runWorkflow(session.threadId, session.adminId, "");
      console.log("[DelayScheduler] runWorkflow reply:", reply);
      if (reply) {
        const creds = await getCredentials(session.adminId);
        if (creds) {
          await sendTextMessage({
            credentials: creds,
            mobile: session.threadId,
            message: reply,
          });
        }
      }
    }
  } catch (err) {
    console.error(
      "[DelayScheduler] resumeDelayedWorkflows error:",
      err instanceof Error ? err.message : err
    );
  }
}
