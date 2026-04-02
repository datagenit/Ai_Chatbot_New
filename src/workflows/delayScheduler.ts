import WorkflowSession from "../models/WorkflowSession.js";
import Workflow from "../models/Workflow.js";
import ExecutionLog from "../models/ExecutionLog.js";
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

export async function expireInactiveSessions(): Promise<void> {
  try {
    const now = new Date();
    const sessions = await WorkflowSession.find({
      done: false,
      expiresAt: { $ne: null, $lte: now },
    });

    console.log(`[DelayScheduler] found ${sessions.length} expired sessions`);

    for (const session of sessions) {
      try {
        // Get expiry message from workflow
        const workflow = await Workflow.findById(session.workflowId).lean();
        const expiryMessage = (workflow as any)?.expiryMessage
          ?? "Your session has expired. Send 'hi' to start again.";

        // Mark done first to prevent race with incoming message
        session.done = true;
        session.expiresAt = null;
        session.updatedAt = new Date();
        await session.save();

        // Mark execution log as expired (fire-and-forget)
        ExecutionLog.findOneAndUpdate(
          { sessionId: session._id.toString() },
          { $set: { status: "expired", completedAt: new Date() } }
        ).catch((logErr: unknown) =>
          console.error(
            "[DelayScheduler] ExecutionLog expiry update failed:",
            logErr instanceof Error ? logErr.message : logErr
          )
        );

        // Send expiry message
        const creds = await getCredentials(session.adminId);
        if (creds && /^\d{10,15}$/.test(session.threadId)) {
          await sendTextMessage({
            credentials: creds,
            mobile: session.threadId,
            message: expiryMessage,
          });
        }
      } catch (sessionErr) {
        console.error(
          "[DelayScheduler] expireInactiveSessions session error:",
          sessionErr instanceof Error ? sessionErr.message : sessionErr
        );
      }
    }
  } catch (err) {
    console.error(
      "[DelayScheduler] expireInactiveSessions error:",
      err instanceof Error ? err.message : err
    );
  }
}
