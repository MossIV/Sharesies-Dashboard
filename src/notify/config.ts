/**
 * Which channels to announce milestones on, and how they are configured.
 *
 * Default behaviour is deliberately conservative: only the console channel runs
 * unless a channel is actually configured, or NOTIFY_CHANNELS names one. A
 * dashboard that quietly starts sending email because a host variable existed in
 * the environment would be a nasty surprise.
 */
import type { Notifier } from "./Notifier.ts";
import {
  ConsoleNotifier,
  EmailNotifier,
  NtfyNotifier,
  WebhookNotifier,
} from "./channels.ts";

export type ChannelName = "console" | "webhook" | "ntfy" | "email";
export const ALL_CHANNELS: ChannelName[] = ["console", "webhook", "ntfy", "email"];

export interface NotifyConfig {
  enabled: boolean;
  channels: ChannelName[];
  /** Channels that were named or implied but have no usable settings. */
  incomplete: { channel: ChannelName; missing: string[] }[];
}

function env(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value === "" ? undefined : value;
}

/** The settings each channel needs before it can be used. */
function missingFor(channel: ChannelName, environment: NodeJS.ProcessEnv): string[] {
  switch (channel) {
    case "console":
      return [];
    case "webhook":
      return env(environment, "NOTIFY_WEBHOOK_URL") ? [] : ["NOTIFY_WEBHOOK_URL"];
    case "ntfy":
      return env(environment, "NOTIFY_NTFY_TOPIC") ? [] : ["NOTIFY_NTFY_TOPIC"];
    case "email": {
      const missing: string[] = [];
      if (!env(environment, "SMTP_HOST")) missing.push("SMTP_HOST");
      if (!env(environment, "NOTIFY_EMAIL_TO")) missing.push("NOTIFY_EMAIL_TO");
      if (!env(environment, "NOTIFY_EMAIL_FROM")) missing.push("NOTIFY_EMAIL_FROM");
      return missing;
    }
  }
}

export function resolveNotifyConfig(environment: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const enabled = env(environment, "NOTIFY_ENABLED")?.toLowerCase() !== "false";
  const configured = env(environment, "NOTIFY_CHANNELS");

  if (configured) {
    const requested = configured
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    const unknown = requested.filter((entry) => !ALL_CHANNELS.includes(entry as ChannelName));
    if (unknown.length > 0) {
      throw new Error(
        `NOTIFY_CHANNELS contains unknown channel(s): ${unknown.join(", ")}. ` +
          `Known channels: ${ALL_CHANNELS.join(", ")}.`,
      );
    }

    const channels = requested as ChannelName[];
    return {
      enabled,
      channels,
      incomplete: channels
        .map((channel) => ({ channel, missing: missingFor(channel, environment) }))
        .filter((entry) => entry.missing.length > 0),
    };
  }

  // Nothing was asked for: run console, plus any channel that is fully set up.
  const channels: ChannelName[] = ["console", ...ALL_CHANNELS.filter((channel) =>
    channel !== "console" && missingFor(channel, environment).length === 0
  )];

  return { enabled, channels, incomplete: [] };
}

/**
 * Build the notifiers for a config.
 *
 * A channel whose settings are incomplete is left out and reported in
 * `problems`, so a half-configured email server cannot silently swallow the
 * announcement.
 */
export function buildNotifiers(
  config: NotifyConfig,
  environment: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): { notifiers: Notifier[]; problems: string[] } {
  const notifiers: Notifier[] = [];
  const problems: string[] = [];

  if (!config.enabled) return { notifiers, problems };

  for (const entry of config.incomplete) {
    problems.push(`${entry.channel} is selected but not configured; missing ${entry.missing.join(", ")}.`);
  }

  const usable = config.channels.filter(
    (channel) => !config.incomplete.some((entry) => entry.channel === channel),
  );

  for (const channel of usable) {
    try {
      switch (channel) {
        case "console":
          notifiers.push(new ConsoleNotifier(log));
          break;
        case "webhook":
          notifiers.push(new WebhookNotifier({ url: env(environment, "NOTIFY_WEBHOOK_URL")! }));
          break;
        case "ntfy":
          notifiers.push(new NtfyNotifier({
            topic: env(environment, "NOTIFY_NTFY_TOPIC")!,
            ...(env(environment, "NOTIFY_NTFY_SERVER") ? { server: env(environment, "NOTIFY_NTFY_SERVER")! } : {}),
            ...(env(environment, "NOTIFY_NTFY_TOKEN") ? { token: env(environment, "NOTIFY_NTFY_TOKEN")! } : {}),
          }));
          break;
        case "email":
          notifiers.push(new EmailNotifier({
            host: env(environment, "SMTP_HOST")!,
            port: Number(env(environment, "SMTP_PORT") ?? "587"),
            // 465 is implicit TLS; 587 uses STARTTLS.
            secure: env(environment, "SMTP_SECURE") === "true" || env(environment, "SMTP_PORT") === "465",
            ...(env(environment, "SMTP_USER") ? { user: env(environment, "SMTP_USER")! } : {}),
            ...(env(environment, "SMTP_PASS") ? { pass: env(environment, "SMTP_PASS")! } : {}),
            from: env(environment, "NOTIFY_EMAIL_FROM")!,
            to: env(environment, "NOTIFY_EMAIL_TO")!,
          }));
          break;
      }
    } catch (error) {
      problems.push(`${channel} could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { notifiers, problems };
}
