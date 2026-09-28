/**
 * Announcing reached milestones (plan section 11, Phase 4).
 *
 * The dedupe rule: a milestone is sent at most once per channel, enforced in the
 * database by `notifications` (unique on milestone_id + channel) and by only
 * selecting milestones with no successful send on that channel. Re-running the
 * daily job therefore cannot spam you, and a channel that failed is retried next
 * time while the ones that succeeded stay quiet.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  getActiveGoal,
  latestSnapshots,
  milestonesAwaitingNotification,
  recordNotification,
  stampMilestoneNotified,
} from "../db/repo.ts";
import { buildMessage, type MilestoneMessage, type Notifier } from "./Notifier.ts";

export interface DispatchResult {
  /** Milestones looked at across all channels. */
  considered: number;
  sent: { channel: string; milestoneId: number; title: string }[];
  failed: { channel: string; milestoneId: number; error: string }[];
  /** Problems with the channel configuration itself, not with a send. */
  problems: string[];
  dryRun: boolean;
}

export interface DispatchOptions {
  notifiers: Notifier[];
  /** Extra context for the message; defaults to the latest stored value. */
  currentValue?: number | null;
  /** Build the messages but send nothing and record nothing. */
  dryRun?: boolean;
  problems?: string[];
  now?: () => Date;
}

export async function dispatchMilestoneNotifications(
  db: DatabaseSync,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const dryRun = options.dryRun ?? false;
  const goal = getActiveGoal(db);

  const result: DispatchResult = {
    considered: 0,
    sent: [],
    failed: [],
    problems: [...(options.problems ?? [])],
    dryRun,
  };

  if (options.notifiers.length === 0) {
    if (result.problems.length === 0) result.problems.push("No notification channels are configured.");
    return result;
  }
  if (goal === null) {
    result.problems.push("There is no active goal, so there is nothing to announce.");
    return result;
  }

  const latest = latestSnapshots(db);
  const currentValue = options.currentValue ??
    (latest.length > 0 ? latest.reduce((sum, snapshot) => sum + snapshot.valueNzd, 0) : null);

  for (const notifier of options.notifiers) {
    const awaiting = milestonesAwaitingNotification(db, notifier.name);

    for (const entry of awaiting) {
      result.considered += 1;

      const message: MilestoneMessage = buildMessage({
        milestoneId: entry.milestone.id,
        milestoneName: entry.milestone.label,
        milestoneAmount: entry.milestone.amountNzd,
        reachedOn: entry.reachedOn,
        goalName: goal.name,
        goalTarget: goal.targetAmountNzd,
        goalTargetDate: goal.targetDate,
        currentValue,
      });

      if (dryRun) {
        result.sent.push({ channel: notifier.name, milestoneId: entry.milestone.id, title: message.title });
        continue;
      }

      try {
        await notifier.send(message);
        recordNotification(db, {
          milestoneId: entry.milestone.id,
          channel: notifier.name,
          status: "sent",
          detail: message.title,
        });
        stampMilestoneNotified(db, entry.milestone.id);
        result.sent.push({ channel: notifier.name, milestoneId: entry.milestone.id, title: message.title });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // Recorded per channel so this channel retries next run while the others
        // stay quiet, and so the failure is visible on the dashboard.
        recordNotification(db, {
          milestoneId: entry.milestone.id,
          channel: notifier.name,
          status: "error",
          error: text,
        });
        result.failed.push({ channel: notifier.name, milestoneId: entry.milestone.id, error: text });
      }
    }
  }

  return result;
}
