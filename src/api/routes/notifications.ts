import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { listNotifications } from "../../db/repo.ts";
import { buildNotifiers, resolveNotifyConfig } from "../../notify/config.ts";
import { dispatchMilestoneNotifications } from "../../notify/dispatch.ts";
import { buildMessage } from "../../notify/Notifier.ts";
import { getActiveGoal, latestSnapshots } from "../../db/repo.ts";
import { todayNz } from "../../db/client.ts";
import { badRequest } from "../validate.ts";

export function notificationRoutes(db: DatabaseSync) {
  const app = new Hono();

  /**
   * What has been announced, and what failed.
   *
   * The failure rows matter: a channel that silently stops working is the failure
   * mode that makes people stop trusting a notifier.
   */
  app.get("/notifications", (c) => {
    const config = resolveNotifyConfig();
    const built = buildNotifiers(config);

    return c.json({
      // Channel names only; no secrets leave the process.
      channels: config.channels,
      enabled: config.enabled,
      problems: [...config.incomplete.map(
        (entry) => `${entry.channel} is selected but not configured; missing ${entry.missing.join(", ")}.`,
      ), ...built.problems],
      notifications: listNotifications(db, 50),
    });
  });

  /**
   * Send a test message through every configured channel.
   *
   * Worth having: "did my webhook actually work" is otherwise only answerable by
   * waiting for a real milestone.
   */
  app.post("/notifications/test", async (c) => {
    const config = resolveNotifyConfig();
    if (!config.enabled) throw badRequest("NOTIFY_ENABLED is false, so nothing would be sent.", { notify: "disabled" });

    const built = buildNotifiers(config);
    if (built.notifiers.length === 0) {
      throw badRequest(
        `No usable notification channel. ${built.problems.join(" ")}`,
        { notify: "no channels" },
      );
    }

    const goal = getActiveGoal(db);
    const latest = latestSnapshots(db);
    const currentValue = latest.length > 0 ? latest.reduce((sum, snapshot) => sum + snapshot.valueNzd, 0) : null;

    const message = buildMessage({
      milestoneId: 0,
      milestoneName: "Test message",
      milestoneAmount: goal?.targetAmountNzd ?? 0,
      reachedOn: todayNz(),
      goalName: goal?.name ?? "No goal set",
      goalTarget: goal?.targetAmountNzd ?? 0,
      goalTargetDate: goal?.targetDate ?? null,
      currentValue,
    });

    const results: { channel: string; ok: boolean; error: string | null }[] = [];
    for (const notifier of built.notifiers) {
      try {
        await notifier.send(message);
        results.push({ channel: notifier.name, ok: true, error: null });
      } catch (error) {
        results.push({
          channel: notifier.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Deliberately not recorded in `notifications`: that table is for real
    // milestones, and a test must not consume a real milestone's dedupe slot.
    return c.json({ results, message: { title: message.title, body: message.body } });
  });

  /** Run the real dispatch now, without collecting a snapshot first. */
  app.post("/notifications/dispatch", async (c) => {
    const config = resolveNotifyConfig();
    const built = buildNotifiers(config);

    const result = await dispatchMilestoneNotifications(db, {
      notifiers: built.notifiers,
      problems: built.problems,
    });

    return c.json(result);
  });

  return app;
}
