/**
 * The Notifier boundary (plan section 11, Phase 4: milestone-reached announcements).
 *
 * One method, so a channel is a small module rather than a branch inside the
 * collector. Every channel is optional and every failure is recorded per channel
 * in the `notifications` table: a dead webhook must not stop email, and must not
 * stop the daily collection either.
 */

export interface MilestoneMessage {
  milestoneId: number;
  milestoneName: string;
  milestoneAmount: number;
  reachedOn: string;
  goalName: string;
  goalTarget: number;
  goalTargetDate: string | null;
  /** The portfolio value now, for context. */
  currentValue: number | null;
  /** milestoneAmount as a percentage of the goal target. */
  percentOfGoal: number;
  title: string;
  body: string;
}

export interface Notifier {
  /** Stable id, also the `notifications.channel` value. */
  readonly name: string;
  /**
   * Send one message. Throw on failure: the caller records the error per
   * channel rather than aborting the whole dispatch.
   */
  send(message: MilestoneMessage): Promise<void>;
}

export class NotifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifierError";
  }
}

/** "25% of the way to $100,000.00" — context, never advice. */
export function buildMessage(input: {
  milestoneId: number;
  milestoneName: string;
  milestoneAmount: number;
  reachedOn: string;
  goalName: string;
  goalTarget: number;
  goalTargetDate: string | null;
  currentValue: number | null;
}): MilestoneMessage {
  const percentOfGoal = input.goalTarget > 0
    ? Math.round((input.milestoneAmount / input.goalTarget) * 1000) / 10
    : 0;

  const money = (value: number): string =>
    new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(value);

  const title = `Milestone reached: ${input.milestoneName}`;

  const lines = [
    `${input.goalName} reached ${money(input.milestoneAmount)} on ${input.reachedOn}.`,
    input.goalTarget > 0
      ? `That is ${percentOfGoal}% of the ${money(input.goalTarget)} goal` +
        (input.goalTargetDate ? `, targeted for ${input.goalTargetDate}.` : ".")
      : ".",
  ];
  if (input.currentValue !== null) {
    lines.push(`The portfolio was worth ${money(input.currentValue)} at the latest collection.`);
  }
  lines.push("Illustrative tracking of your own data, not financial advice.");

  return {
    milestoneId: input.milestoneId,
    milestoneName: input.milestoneName,
    milestoneAmount: input.milestoneAmount,
    reachedOn: input.reachedOn,
    goalName: input.goalName,
    goalTarget: input.goalTarget,
    goalTargetDate: input.goalTargetDate,
    currentValue: input.currentValue,
    percentOfGoal,
    title,
    body: lines.join(" "),
  };
}
