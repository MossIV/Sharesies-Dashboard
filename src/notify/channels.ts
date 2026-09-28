/**
 * The built-in channels.
 *
 * Deliberately small and dependency-free where possible:
 *   console — always available, and what the scheduled CLI job uses
 *   webhook — any JSON endpoint (Home Assistant, Zapier, a script)
 *   ntfy    — free push to a phone, which is the realistic "tell me at $25k"
 *   email   — SMTP, so it stays inert until SMTP settings are supplied
 */
import type { MilestoneMessage, Notifier } from "./Notifier.ts";
import { NotifierError } from "./Notifier.ts";

export class ConsoleNotifier implements Notifier {
  readonly name = "console";
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void = console.log) {
    this.#log = log;
  }

  async send(message: MilestoneMessage): Promise<void> {
    this.#log(`[milestone] ${message.title} — ${message.body}`);
  }
}

export interface WebhookOptions {
  url: string;
  /** Extra fields merged into the payload, e.g. an auth token or a channel id. */
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WebhookNotifier implements Notifier {
  readonly name = "webhook";
  readonly #options: WebhookOptions;

  constructor(options: WebhookOptions) {
    if (!/^https?:\/\//.test(options.url)) {
      throw new NotifierError(`NOTIFY_WEBHOOK_URL must be http(s): got ${options.url}`);
    }
    this.#options = options;
  }

  async send(message: MilestoneMessage): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(this.#options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.#options.headers ?? {}) },
      body: JSON.stringify({
        ...(this.#options.payload ?? {}),
        title: message.title,
        message: message.body,
        milestone: {
          id: message.milestoneId,
          name: message.milestoneName,
          amount: message.milestoneAmount,
          reachedOn: message.reachedOn,
          percentOfGoal: message.percentOfGoal,
        },
        goal: { name: message.goalName, target: message.goalTarget, targetDate: message.goalTargetDate },
        currentValue: message.currentValue,
      }),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      throw new NotifierError(`webhook returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
  }
}

export interface NtfyOptions {
  /** The topic you subscribe to in the ntfy app. Treat it as a password. */
  topic: string;
  server?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * ntfy.sh is a free push service: subscribe to a topic in their app and this
 * posts to it. The topic name is the only secret, so a long random one is used.
 */
export class NtfyNotifier implements Notifier {
  readonly name = "ntfy";
  readonly #options: NtfyOptions;

  constructor(options: NtfyOptions) {
    if (!options.topic.trim()) throw new NotifierError("NOTIFY_NTFY_TOPIC must not be empty");
    this.#options = options;
  }

  async send(message: MilestoneMessage): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch;
    const server = (this.#options.server ?? "https://ntfy.sh").replace(/\/$/, "");

    const response = await fetchImpl(`${server}/${encodeURIComponent(this.#options.topic)}`, {
      method: "POST",
      headers: {
        // HTTP headers must be latin-1; the body carries the readable text.
        Title: "Sharesies goal milestone",
        Priority: "default",
        Tags: "chart_with_upwards_trend",
        ...(this.#options.token ? { Authorization: `Bearer ${this.#options.token}` } : {}),
      },
      body: `${message.title}\n\n${message.body}`,
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      throw new NotifierError(`ntfy returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
  }
}

export interface EmailOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  timeoutMs?: number;
}

/**
 * SMTP email. nodemailer is imported lazily so a dashboard that never configures
 * email never loads it, and so the dependency stays out of the path of the
 * collector when it is not installed.
 */
export class EmailNotifier implements Notifier {
  readonly name = "email";
  readonly #options: EmailOptions;

  constructor(options: EmailOptions) {
    if (!options.to.trim()) throw new NotifierError("NOTIFY_EMAIL_TO must not be empty");
    this.#options = options;
  }

  async send(message: MilestoneMessage): Promise<void> {
    let nodemailer: typeof import("nodemailer");
    try {
      nodemailer = await import("nodemailer");
    } catch {
      throw new NotifierError("nodemailer is not installed. Run: npm install nodemailer");
    }

    const transporter = nodemailer.createTransport({
      host: this.#options.host,
      port: this.#options.port,
      secure: this.#options.secure,
      ...(this.#options.user ? { auth: { user: this.#options.user, pass: this.#options.pass ?? "" } } : {}),
      connectionTimeout: this.#options.timeoutMs ?? 15_000,
    });

    await transporter.sendMail({
      from: this.#options.from,
      to: this.#options.to,
      subject: message.title,
      text: message.body,
    });
  }
}
