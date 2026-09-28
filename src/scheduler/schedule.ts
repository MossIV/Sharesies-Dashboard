/**
 * When the daily job should run next.
 *
 * Pure, so it can be tested around the two days a year that break naive
 * scheduling: New Zealand moves its clocks twice, and a daily 07:00 run is 23
 * hours after the previous one on the day daylight saving starts, and 25 hours
 * after on the day it ends. Anything that adds 24 hours to an instant gets those
 * two days wrong, which for a once-a-day snapshot means a missed day and a
 * double-collected day every year.
 *
 * The rule here works in wall-clock terms: find the target time on the calendar,
 * then convert that wall time to an instant using the offset in force at that
 * moment, not the offset in force now.
 */

export const DEFAULT_TIME_ZONE = "Pacific/Auckland";

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ScheduleSlot {
  /** 0-23, in the schedule's time zone. */
  hour: number;
  /** 0-59. */
  minute: number;
  timeZone?: string;
}

/** The wall-clock reading of an instant in a zone. */
export function partsInZone(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    if (!part) throw new Error(`No ${type} in the formatted date for ${timeZone}`);
    return Number(part.value);
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Milliseconds the zone is ahead of UTC at that instant (NZ: 12h or 13h). */
export function offsetMs(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const wall = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Drop sub-second noise: the formatter has second precision.
  return asIfUtc - (instant.getTime() - instant.getMilliseconds());
}

/**
 * The instant at which a zone's wall clock reads the given time.
 *
 * The offset at the answer can differ from the offset used to guess it, so two
 * candidates are computed and checked by reading them back:
 *
 *  - **A time that happens once** reads back correctly from one candidate.
 *  - **A time that happens twice** (the hour repeated when the clocks go back)
 *    reads back correctly from both. The earlier one is returned, matching the
 *    "compatible" behaviour of `Temporal` and of every other library, so the two
 *    plausible answers do not depend on which way the offset was guessed.
 *  - **A time that does not happen** (the hour skipped when the clocks go
 *    forward) reads back correctly from neither, and the later instant wins: the
 *    clocks have already jumped when the wall clock next reads that time.
 *
 * None of this is reachable from a schedule set to a normal time of day, which is
 * exactly why it is worth pinning down in tests rather than trusting.
 */
export function zonedTimeToInstant(wall: WallClock, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  // Build the candidates from the offset in force a day before and a day after,
  // not from the offset at the guessed instant: on a transition day the guess
  // already carries the new offset, so it can never find the earlier of two
  // valid answers.
  const offsets = new Set([
    offsetMs(new Date(asIfUtc - 86_400_000), timeZone),
    offsetMs(new Date(asIfUtc + 86_400_000), timeZone),
  ]);
  const candidates = [...offsets].map((offset) => new Date(asIfUtc - offset));

  const matches = (instant: Date): boolean => {
    const parts = partsInZone(instant, timeZone);
    return (
      parts.year === wall.year &&
      parts.month === wall.month &&
      parts.day === wall.day &&
      parts.hour === wall.hour &&
      parts.minute === wall.minute
    );
  };

  const reading = candidates.filter(matches).map((instant) => instant.getTime());
  if (reading.length > 0) return new Date(Math.min(...reading));

  // A skipped hour: neither candidate reads back, so take the later one.
  return new Date(Math.max(...candidates.map((instant) => instant.getTime())));
}

/** The next time the slot comes round, strictly after `now`. */
export function nextRunAfter(now: Date, slot: ScheduleSlot): Date {
  const timeZone = slot.timeZone ?? DEFAULT_TIME_ZONE;
  const today = partsInZone(now, timeZone);

  const todayAt = zonedTimeToInstant(
    { ...today, hour: slot.hour, minute: slot.minute, second: 0 },
    timeZone,
  );
  if (todayAt.getTime() > now.getTime()) return todayAt;

  // Step the calendar date, not the instant: adding 24 hours would drift across
  // a transition.
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + 86_400_000);
  return zonedTimeToInstant(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      hour: slot.hour,
      minute: slot.minute,
      second: 0,
    },
    timeZone,
  );
}

/** "07:00 on 29 September 2026 (Pacific/Auckland)", for a log line. */
export function describeInstant(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const wall = partsInZone(instant, timeZone);
  const month = new Intl.DateTimeFormat("en-NZ", { timeZone, month: "long" }).format(instant);
  const clock = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
  return `${clock} on ${wall.day} ${month} ${wall.year} (${timeZone})`;
}

/** Hours until the instant, rounded to one decimal, for logging. */
export function hoursUntil(instant: Date, now: Date = new Date()): number {
  return Math.round(((instant.getTime() - now.getTime()) / 3_600_000) * 10) / 10;
}

/**
 * A wait that can be cut short.
 *
 * The scheduler sleeps until its next run in one long timer, and a signal only
 * sets a flag. A plain `setTimeout` therefore keeps the process alive until the
 * timer fires — up to a minute — so `docker stop` would wait out its grace period
 * and kill the container instead of letting it exit. Cancelling the pending timer
 * makes the stop immediate.
 */
export function createWaiter(): { wait: (ms: number) => Promise<void>; cancel: () => void } {
  let cancelCurrent: (() => void) | null = null;

  return {
    wait(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelCurrent = null;
          resolve();
        }, ms);
        cancelCurrent = () => {
          clearTimeout(timer);
          cancelCurrent = null;
          resolve();
        };
      });
    },
    cancel(): void {
      cancelCurrent?.();
    },
  };
}