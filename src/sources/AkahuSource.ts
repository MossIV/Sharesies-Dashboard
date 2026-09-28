/**
 * AkahuSource — the main PortfolioSource (plan section 5, step 1).
 *
 * Auth is two static headers against https://api.akahu.io/v1:
 *   Authorization: Bearer <user token>
 *   X-Akahu-Id:    <app token>
 *
 * Retry policy follows Akahu's documented guidance: exponential backoff from a
 * 100 ms base with random jitter, on 429 and on 5xx.
 */
import type { FetchResult, PortfolioSource } from "./PortfolioSource.ts";
import { extractItems, normalizeAccounts } from "./parse-akahu.ts";
import { nextCursor } from "./parse-transactions.ts";

export const AKAHU_BASE_URL = "https://api.akahu.io/v1";
const RETRY_BACKOFF_BASE_MS = 100;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class AkahuError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "AkahuError";
    this.status = status;
    this.body = body;
  }
}

/** Documented jittered exponential backoff (Rate Limits guide). */
export function retryDelayMs(retryCount: number, random: () => number = Math.random): number {
  const jitter = 0.75 + random() / 2;
  return RETRY_BACKOFF_BASE_MS * 2 ** retryCount * jitter;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

export interface AkahuSourceOptions {
  appToken?: string | undefined;
  userToken?: string | undefined;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AkahuSource implements PortfolioSource {
  readonly name = "akahu";
  readonly baseUrl: string;
  readonly #appToken: string;
  readonly #userToken: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: AkahuSourceOptions = {}) {
    this.#appToken = options.appToken ?? process.env["AKAHU_APP_TOKEN"] ?? "";
    this.#userToken = options.userToken ?? process.env["AKAHU_USER_TOKEN"] ?? "";
    this.baseUrl = (options.baseUrl ?? AKAHU_BASE_URL).replace(/\/$/, "");
    this.#maxRetries = options.maxRetries ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#log = options.log ?? (() => {});
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  static isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env["AKAHU_APP_TOKEN"]?.trim() && env["AKAHU_USER_TOKEN"]?.trim());
  }

  #assertConfigured(): void {
    if (!this.#appToken.trim() || !this.#userToken.trim()) {
      throw new AkahuError(
        "Akahu tokens are missing. Set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN in .env " +
          "(see .env.example), or set PORTFOLIO_SOURCE=manual.",
        0,
      );
    }
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#userToken}`,
      "X-Akahu-Id": this.#appToken,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "sharesies-dashboard/0.1 (personal app)",
    };
  }

  /** GET/POST with retry. Returns the parsed JSON body. */
  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    this.#assertConfigured();
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs(attempt - 1, this.#random);
        this.#log(`retrying ${path} in ${Math.round(delay)}ms (attempt ${attempt})`);
        await this.#sleep(delay);
      }

      try {
        const response = await this.#fetch(url, {
          method: init.method ?? "GET",
          headers: this.#headers(),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        const text = await response.text();

        if (response.ok) {
          if (text.trim() === "") return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new AkahuError(`Akahu returned non-JSON from ${path}`, response.status, text);
          }
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.#maxRetries) {
          const waitMs = retryAfterMs(response.headers.get("retry-after"));
          this.#log(
            `Akahu ${response.status} on ${path}` +
              (waitMs !== null ? `, Retry-After ${waitMs}ms` : ""),
          );
          if (waitMs !== null && waitMs > 0) await this.#sleep(Math.min(waitMs, 60_000));
          continue;
        }

        throw new AkahuError(
          `Akahu request failed: ${init.method ?? "GET"} ${path} -> ${response.status}`,
          response.status,
          text.slice(0, 2000),
        );
      } catch (error) {
        // Network/timeout errors are worth retrying too; HTTP errors are already
        // decided above and must not be swallowed.
        if (error instanceof AkahuError) throw error;
        lastError = error;
        if (attempt >= this.#maxRetries) break;
        this.#log(`network error on ${path}: ${String(error)}`);
      }
    }

    throw new AkahuError(
      `Akahu request failed after ${this.#maxRetries + 1} attempts: ${path}: ${String(lastError)}`,
      0,
    );
  }

  async fetchAccounts(): Promise<FetchResult> {
    const raw = await this.request("/accounts");
    return {
      endpoint: "/accounts",
      raw,
      accounts: normalizeAccounts(raw),
    };
  }

  /**
   * One page of `GET /transactions`.
   *
   * `start`/`end` are inclusive ISO dates. Akahu returns only what it has already
   * refreshed, so a scan can come back empty on a fresh connection.
   */
  async fetchTransactionsPage(
    options: { from?: string | undefined; to?: string | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: unknown[]; next: string | null; raw: unknown; path: string }> {
    const params = new URLSearchParams();
    if (options.from) params.set("start", options.from);
    if (options.to) params.set("end", options.to);
    if (options.cursor) params.set("cursor", options.cursor);

    const path = `/transactions${params.size > 0 ? `?${params.toString()}` : ""}`;
    const raw = await this.request(path);
    return { items: extractItems(raw), next: nextCursor(raw), raw, path };
  }

  /**
   * Every page of `GET /transactions` for a window.
   *
   * Pagination is bounded: a cursor that repeats, or a page count above the cap,
   * stops the walk instead of looping forever against a live API.
   */
  async fetchTransactions(
    options: { from?: string | undefined; to?: string | undefined; maxPages?: number } = {},
  ): Promise<{ items: unknown[]; pages: number; raw: unknown[] }> {
    const maxPages = options.maxPages ?? 20;
    const items: unknown[] = [];
    const raw: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    for (let page = 0; page < maxPages; page++) {
      const result: Awaited<ReturnType<AkahuSource["fetchTransactionsPage"]>> =
        await this.fetchTransactionsPage({
          from: options.from,
          to: options.to,
          ...(cursor === undefined ? {} : { cursor }),
        });

      items.push(...result.items);
      raw.push(result.raw);
      pages += 1;

      if (result.next === null) break;
      if (seen.has(result.next)) {
        this.#log(`stopping transaction paging: cursor repeated (${result.next})`);
        break;
      }
      seen.add(result.next);
      cursor = result.next;
    }

    return { items, pages, raw };
  }

  async getMe<T = unknown>(): Promise<T> {
    return this.request<T>("/me");
  }

  /**
   * POST /refresh — ask Akahu to refresh account data now.
   *
   * Personal apps have a 1 hour manual refresh rest period, and Akahu may
   * simply ignore the instruction when data was refreshed recently. The
   * response reports per-account outcome, so the caller should surface
   * "ignored" as "already fresh", not as an error.
   */
  async requestRefresh(accountIds?: string[]): Promise<unknown> {
    return this.request("/refresh", {
      method: "POST",
      ...(accountIds && accountIds.length > 0 ? { body: { accounts: accountIds } } : {}),
    });
  }
}
