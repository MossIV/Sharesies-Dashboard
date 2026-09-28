import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { createGoal, createMilestone, listNotifications } from "../src/db/repo.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { buildMessage, type MilestoneMessage, type Notifier } from "../src/notify/Notifier.ts";
import { buildNotifiers, resolveNotifyConfig } from "../src/notify/config.ts";
import { ConsoleNotifier, NtfyNotifier, WebhookNotifier } from "../src/notify/channels.ts";
import { dispatchMilestoneNotifications } from "../src/notify/dispatch.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { loadFixture, testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

const NOW = new Date("2026-09-28T04:00:00.000Z");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["NOTIFY_WEBHOOK_URL"];
  delete process.env["NOTIFY_NTFY_TOPIC"];
  delete process.env["NOTIFY_CHANNELS"];
  delete process.env["NOTIFY_ENABLED"];
  process.env["NOTIFY_ENABLED"] = "false";
  delete process.env["SMTP_HOST"];
  delete process.env["NOTIFY_EMAIL_TO"];
});

class RecordingNotifier implements Notifier {
  readonly name: string;
  readonly sent: MilestoneMessage[] = [];
  readonly #fail: string | null;

  constructor(name: string, fail: string | null = null) {
    this.name = name;
    this.#fail = fail;
  }

  async send(message: MilestoneMessage): Promise<void> {
    if (this.#fail) throw new Error(this.#fail);
    this.sent.push(message);
  }
}

function valueSource(value: number): PortfolioSource {
  return {
    name: "manual",
    fetchAccounts: async () => ({
      endpoint: "manual",
      raw: { value },
      accounts: normalizeAccounts({
        items: [{
          _id: "manual:sharesies",
          name: "Sharesies (manual)",
          connection: { name: "Sharesies" },
          type: "INVESTMENT",
          balance: { currency: "NZD", current: value },
          refreshed: { balance: NOW.toISOString() },
          status: "ACTIVE",
        }],
      }),
    }),
  };
}

function seededDb() {
  const db = testDb();
  return db;
}

function goalWithMilestones(db: ReturnType<typeof testDb>, milestones: [string, number][]): void {
  const goal = createGoal(db, {
    name: "First $100k",
    targetAmountNzd: 100_000,
    targetDate: "2028-09-27",
    progressBasis: "value",
  });
  for (const [label, amount] of milestones) {
    createMilestone(db, { goalId: goal.id, label, amountNzd: amount });
  }
}

describe("buildMessage", () => {
  test("states the milestone, the goal and the percentage without advising", () => {
    const message = buildMessage({
      milestoneId: 1,
      milestoneName: "25% of goal",
      milestoneAmount: 25_000,
      reachedOn: "2026-09-14",
      goalName: "First $100k",
      goalTarget: 100_000,
      goalTargetDate: "2028-09-27",
      currentValue: 26_120.44,
    });

    assert.equal(message.title, "Milestone reached: 25% of goal");
    assert.ok(message.body.includes("$25,000.00"), message.body);
    assert.ok(message.body.includes("25% of the $100,000.00 goal"), message.body);
    assert.ok(message.body.includes("not financial advice"), message.body);
    assert.equal(message.percentOfGoal, 25);
  });

  test("handles a goal with no target amount", () => {
    const message = buildMessage({
      milestoneId: 1, milestoneName: "Buffer", milestoneAmount: 5000,
      reachedOn: "2026-09-14", goalName: "Goal", goalTarget: 0,
      goalTargetDate: null, currentValue: null,
    });
    assert.equal(message.percentOfGoal, 0);
    assert.ok(!message.body.includes("NaN"), message.body);
  });
});

describe("resolveNotifyConfig / buildNotifiers", () => {
  test("only the console channel runs when nothing else is configured", () => {
    delete process.env["NOTIFY_ENABLED"];
    const config = resolveNotifyConfig({});
    assert.deepEqual(config.channels, ["console"]);
    assert.deepEqual(config.incomplete, []);
  });

  test("a fully configured channel is used automatically", () => {
    const config = resolveNotifyConfig({ NOTIFY_NTFY_TOPIC: "my-topic" });
    assert.deepEqual(config.channels, ["console", "ntfy"]);
  });

  test("an explicitly selected channel is authoritative, and incomplete ones are reported", () => {
    const config = resolveNotifyConfig({ NOTIFY_CHANNELS: "webhook,email" });
    assert.deepEqual(config.channels, ["webhook", "email"]);
    assert.deepEqual(config.incomplete.map((entry) => entry.channel), ["webhook", "email"]);
    assert.deepEqual(config.incomplete[0]?.missing, ["NOTIFY_WEBHOOK_URL"]);
    assert.ok(config.incomplete[1]?.missing.includes("SMTP_HOST"));

    const built = buildNotifiers(config, { NOTIFY_CHANNELS: "webhook,email" });
    assert.equal(built.notifiers.length, 0, "a half-configured channel is never built");
    assert.equal(built.problems.length, 2);
  });

  test("an unknown channel name is an error, not a silent no-op", () => {
    assert.throws(() => resolveNotifyConfig({ NOTIFY_CHANNELS: "carrier-pigeon" }), /unknown channel/i);
  });

  test("NOTIFY_ENABLED=false disables everything", () => {
    const config = resolveNotifyConfig({ NOTIFY_ENABLED: "false", NOTIFY_NTFY_TOPIC: "x" });
    assert.equal(config.enabled, false);
    assert.equal(buildNotifiers(config, { NOTIFY_NTFY_TOPIC: "x" }).notifiers.length, 0);
  });

  test("builds each channel from its settings", () => {
    // The same environment must resolve the config and build it: a config built
    // against half the settings would drop channels that are actually usable.
    const environment = {
      NOTIFY_CHANNELS: "console,webhook,ntfy,email",
      NOTIFY_WEBHOOK_URL: "https://example.test/hook",
      NOTIFY_NTFY_TOPIC: "topic-abc",
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      NOTIFY_EMAIL_FROM: "from@example.test",
      NOTIFY_EMAIL_TO: "to@example.test",
    };

    const config = resolveNotifyConfig(environment);
    assert.deepEqual(config.channels, ["console", "webhook", "ntfy", "email"]);
    assert.deepEqual(config.incomplete, [], "every selected channel is configured");

    const built = buildNotifiers(config, environment, () => {});
    assert.deepEqual(built.notifiers.map((notifier) => notifier.name), ["console", "webhook", "ntfy", "email"]);
    assert.deepEqual(built.problems, []);
  });

  test("a webhook URL that is not http(s) is rejected", () => {
    assert.throws(() => new WebhookNotifier({ url: "file:///etc/passwd" }), /http/i);
  });
});

describe("channels", () => {
  const message = buildMessage({
    milestoneId: 1, milestoneName: "25% of goal", milestoneAmount: 25_000,
    reachedOn: "2026-09-14", goalName: "First $100k", goalTarget: 100_000,
    goalTargetDate: "2028-09-27", currentValue: 26_120.44,
  });

  test("console prints the message", async () => {
    const lines: string[] = [];
    await new ConsoleNotifier((line) => lines.push(line)).send(message);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Milestone reached: 25% of goal/);
  });

  test("webhook posts the JSON payload", async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await new WebhookNotifier({ url: "https://example.test/hook", payload: { source: "dashboard" } }).send(message);

    assert.equal(captured!.url, "https://example.test/hook");
    assert.equal(captured!.body.source, "dashboard", "extra payload fields are merged in");
    assert.equal(captured!.body.title, message.title);
    assert.equal(captured!.body.milestone.amount, 25_000);
  });

  test("a failing webhook throws with the status, so it is recorded", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => new WebhookNotifier({ url: "https://example.test/hook" }).send(message),
      /webhook returned 500/,
    );
  });

  test("ntfy posts to the topic", async () => {
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: init.body };
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await new NtfyNotifier({ topic: "my topic" }).send(message);
    assert.equal(captured!.url, "https://ntfy.sh/my%20topic");
    assert.ok(captured!.body.includes("Milestone reached"));
  });
});

describe("dispatchMilestoneNotifications", () => {
  test("announces a reached milestone once per channel", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000], ["100% of goal", 100_000]]);
    await collectOnce(db, { source: valueSource(26_000), now: NOW, notify: false });

    const console = new RecordingNotifier("console");
    const webhook = new RecordingNotifier("webhook");

    const first = await dispatchMilestoneNotifications(db, { notifiers: [console, webhook] });
    assert.equal(first.sent.length, 2, "one per channel");
    assert.equal(first.failed.length, 0);
    assert.equal(console.sent.length, 1);
    assert.equal(console.sent[0]?.milestoneName, "25% of goal");
    assert.equal(console.sent[0]?.percentOfGoal, 25);

    // Re-running must not re-announce.
    const second = await dispatchMilestoneNotifications(db, { notifiers: [console, webhook] });
    assert.equal(second.sent.length, 0);
    assert.equal(second.considered, 0);
    assert.equal(console.sent.length, 1);

    db.close();
  });

  test("a failing channel is recorded and retried, while a working one stays quiet", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000]]);
    await collectOnce(db, { source: valueSource(26_000), now: NOW, notify: false });

    const working = new RecordingNotifier("console");
    const broken = new RecordingNotifier("webhook", "webhook returned 500: nope");

    const first = await dispatchMilestoneNotifications(db, { notifiers: [working, broken] });
    assert.equal(first.sent.length, 1);
    assert.equal(first.failed.length, 1);
    assert.match(first.failed[0]!.error, /500/);

    const rows = listNotifications(db);
    assert.equal(rows.length, 2);
    const failedRow = rows.find((row) => row.channel === "webhook");
    assert.equal(failedRow?.status, "error");
    assert.match(failedRow?.error ?? "", /500/);

    // The broken channel is retried; the working one is not.
    const second = await dispatchMilestoneNotifications(db, { notifiers: [working, broken] });
    assert.equal(second.sent.length, 0);
    assert.equal(second.failed.length, 1);
    assert.equal(working.sent.length, 1);

    db.close();
  });

  test("a dry run sends nothing and records nothing", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000]]);
    await collectOnce(db, { source: valueSource(26_000), now: NOW, notify: false });

    const console = new RecordingNotifier("console");
    const result = await dispatchMilestoneNotifications(db, { notifiers: [console], dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.sent.length, 1);
    assert.equal(console.sent.length, 0, "nothing was actually sent");
    assert.equal(listNotifications(db).length, 0, "nothing was recorded");

    db.close();
  });

  test("an unreached milestone is never announced", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000]]);
    await collectOnce(db, { source: valueSource(1000), now: NOW, notify: false });

    const console = new RecordingNotifier("console");
    const result = await dispatchMilestoneNotifications(db, { notifiers: [console] });
    assert.equal(result.sent.length, 0);
    assert.equal(console.sent.length, 0);

    db.close();
  });

  test("no channels, or no goal, is reported rather than silently successful", async () => {
    const db = seededDb();
    const none = await dispatchMilestoneNotifications(db, { notifiers: [] });
    assert.deepEqual(none.problems, ["No notification channels are configured."]);

    const console = new RecordingNotifier("console");
    const noGoal = await dispatchMilestoneNotifications(db, { notifiers: [console] });
    assert.ok(noGoal.problems[0]?.includes("no active goal"), noGoal.problems.join(" | "));

    db.close();
  });

  test("collection announces the milestone it just reached", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000]]);

    const console = new RecordingNotifier("console");
    const result = await collectOnce(db, {
      source: valueSource(26_000),
      now: NOW,
      snapshotDate: "2026-09-14",
      notify: [console],
    });

    assert.equal(result.milestonesStamped, 1);
    assert.equal(result.notifications.sent, 1);
    assert.equal(result.notifications.failed, 0);
    assert.match(console.sent[0]?.body ?? "", /reached \$25,000\.00 on 2026-09-14/);

    db.close();
  });

  test("a failing channel does not fail the collection", async () => {
    const db = seededDb();
    goalWithMilestones(db, [["25% of goal", 25_000]]);

    const result = await collectOnce(db, {
      source: valueSource(26_000),
      now: NOW,
      snapshotDate: "2026-09-14",
      notify: [new RecordingNotifier("webhook", "connection refused")],
    });

    assert.equal(result.status, "partial", "the snapshot is still stored");
    assert.equal(result.snapshotsWritten, 1);
    assert.equal(result.notifications.failed, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("connection refused")));
    assert.equal(listNotifications(db)[0]?.status, "error");

    db.close();
  });
});

describe("notification endpoints", () => {
  test("GET /api/notifications lists channels and history without leaking secrets", async () => {
    const db = seededDb();
    const app = createApp(db, { today: "2026-09-28" });
    process.env["NOTIFY_CHANNELS"] = "webhook";
    process.env["NOTIFY_WEBHOOK_URL"] = "https://hooks.example.test/secret-looking-path";

    const body = await (await app.request("/api/notifications")).json() as any;
    assert.deepEqual(body.channels, ["webhook"]);
    assert.deepEqual(body.problems, []);
    assert.deepEqual(body.notifications, []);
    assert.ok(
      !JSON.stringify(body).includes("secret-looking-path"),
      "the channel list must not echo the webhook URL",
    );

    db.close();
  });

  test("POST /api/notifications/test reports per-channel results", async () => {
    const db = seededDb();
    const app = createApp(db, { today: "2026-09-28" });
    // Tests run with notifications disabled by default (tests/helpers.ts); this
    // test is specifically about the enabled path.
    process.env["NOTIFY_ENABLED"] = "true";
    process.env["NOTIFY_CHANNELS"] = "webhook";
    process.env["NOTIFY_WEBHOOK_URL"] = "https://hooks.example.test/ok";

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("", { status: attempts === 1 ? 200 : 500 });
    }) as typeof fetch;

    const ok = await (await app.request("/api/notifications/test", { method: "POST" })).json() as any;
    assert.deepEqual(ok.results, [{ channel: "webhook", ok: true, error: null }]);
    assert.equal(listNotifications(db).length, 0, "a test must not consume a milestone's slot");

    const failed = await (await app.request("/api/notifications/test", { method: "POST" })).json() as any;
    assert.equal(failed.results[0].ok, false);
    assert.match(failed.results[0].error, /500/);

    db.close();
  });

  test("a disabled or unconfigured notifier is refused with an explanation", async () => {
    const db = seededDb();
    const app = createApp(db, { today: "2026-09-28" });

    process.env["NOTIFY_ENABLED"] = "false";
    const disabled = await app.request("/api/notifications/test", { method: "POST" });
    assert.equal(disabled.status, 400);
    assert.match((await disabled.json() as any).error, /NOTIFY_ENABLED/);

    delete process.env["NOTIFY_ENABLED"];
    process.env["NOTIFY_CHANNELS"] = "webhook";
    const unconfigured = await app.request("/api/notifications/test", { method: "POST" });
    assert.equal(unconfigured.status, 400);
    assert.match((await unconfigured.json() as any).error, /NOTIFY_WEBHOOK_URL/);

    db.close();
  });
});

describe("enrichment fixture", () => {
  test("a real Akahu account response is still parsed after the transaction work", () => {
    const accounts = normalizeAccounts(loadFixture("accounts.sharesies-portfolio.sample.json"));
    assert.equal(accounts.length, 3);
  });
});
