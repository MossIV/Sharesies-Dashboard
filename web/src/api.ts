/**
 * Typed client for the local API. Types mirror src/api on the server; they are
 * duplicated rather than shared because the two packages build independently.
 */

export interface Milestone {
  id: number;
  goalId: number;
  label: string;
  amountNzd: number;
  kind: "custom" | "percent";
  percent: number | null;
  firstReachedOn: string | null;
  notes: string | null;
}

export interface EvaluatedMilestone extends Milestone {
  state: "reached" | "next" | "future";
  currentlyBelow: boolean;
  gap: number;
  progressPct: number;
}

export interface Pace {
  status: "ahead" | "on_track" | "behind" | "unknown";
  expectedValue: number | null;
  delta: number | null;
  deltaPct: number | null;
  baselineDate: string | null;
  baselineValue: number | null;
}

export interface SummaryGoal {
  id: number;
  name: string;
  targetAmountNzd: number;
  targetDate: string | null;
  progressBasis: "value" | "contributions";
  isActive: boolean;
  createdAt: string;
  currentValue: number;
  progressValue: number;
  progressPct: number;
  remaining: number;
  pace: Pace;
  requiredMonthly: number | null;
  targetPassed: boolean;
}

export interface SyncHealth {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastSuccessAt: string | null;
  lastSnapshotDate: string | null;
  firstSnapshotDate: string | null;
  daysCollected: number;
  daysSinceLastSnapshot: number | null;
  accounts: {
    accountId: string;
    accountName: string;
    connectionName: string | null;
    accountType: string | null;
    inScope: boolean;
    valueNzd: number;
    status: "ACTIVE" | "INACTIVE";
    sourceRefreshedAt: string | null;
    ageHours: number | null;
  }[];
  excludedAccounts: string[];
  hasInactive: boolean;
  stale: boolean;
  staleReason: string | null;
  staleAfterHours: number;
}

export interface Summary {
  asOf: string;
  currentValue: number;
  currency: string;
  netContributions: number;
  change7d: number | null;
  change30d: number | null;
  goal: SummaryGoal | null;
  milestones: EvaluatedMilestone[];
  nextMilestone: EvaluatedMilestone | null;
  syncHealth: SyncHealth;
  dataMode: "akahu" | "manual" | "demo" | "unknown";
}

export interface SnapshotSeries {
  from: string | null;
  to: string | null;
  points: { date: string; value: number }[];
  first: number | null;
  last: number | null;
}

export interface Holdings {
  available: boolean;
  note: string | null;
  totalValue: number;
  holdings: {
    id: number;
    name: string | null;
    symbol: string | null;
    units: number | null;
    value: number | null;
    sharePct: number | null;
  }[];
}

export interface Contribution {
  id: number;
  contributionDate: string;
  amountNzd: number;
  note: string | null;
  source: "manual" | "csv" | "bank";
  createdAt: string;
}

export interface Projection {
  disclaimer: string;
  assumptions: {
    startValue: number;
    startDate: string;
    annualReturn: number;
    monthlyContribution: number;
    spread: number;
    months: number;
  };
  scenarios: {
    key: "low" | "base" | "high";
    annualReturn: number;
    endValue: number;
    points: { month: number; date: string; value: number; contributed: number }[];
  }[];
  milestones: {
    id: number;
    label: string;
    amountNzd: number;
    kind: "custom" | "percent";
    alreadyReached: boolean;
    firstReachedOn: string | null;
    etas: Record<"low" | "base" | "high", number | null>;
    etaDates: Record<"low" | "base" | "high", string | null>;
  }[];
  goal: {
    id: number;
    name: string;
    targetAmountNzd: number;
    targetDate: string | null;
    requiredMonthly: number | null;
    targetEta: Record<"low" | "base" | "high", string | null>;
  } | null;
}

export interface Account {
  accountId: string;
  accountName: string;
  connectionName: string | null;
  accountType: string | null;
  currency: string;
  status: "ACTIVE" | "INACTIVE";
  inScope: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  latestValue: number | null;
  latestSnapshotDate: string | null;
}

export interface AccountList {
  accounts: Account[];
  inScopeCount: number;
  defaultRule: { connectionMatch: string; accountTypes: string[] };
}

export interface CsvImportRow {
  rowNumber: number;
  date: string | null;
  description: string;
  category: string;
  amountNzd: number;
  balance: number | null;
  externalRef: string;
}

export interface CsvImportResult {
  mode: "preview" | "apply";
  selected: CsvImportRow[];
  transactions: CsvImportRow[];
  imported: number;
  skipped: number;
  importId: number | null;
  detected: {
    delimiter: string;
    columns: Record<string, number | undefined>;
    unrecognisedColumns: string[];
    dateFormat: string;
    dateAmbiguous: boolean;
    raggedRows: number;
    counts: Record<string, number>;
  };
  warnings: string[];
}

export interface ImportRecord {
  id: number;
  kind: string;
  filename: string | null;
  importedAt: string;
  rowsSeen: number;
  rowsImported: number;
  rowsSkipped: number;
}

export interface Settings {
  assumptions: { annualReturn: number; monthlyContribution: number };
  source: {
    requested: string | null;
    effective: "akahu" | "manual";
    akahuConfigured: boolean;
    connectionMatch: string;
    accountTypes: string[];
  };
  manualValueNzd: string | null;
  limits: {
    annualReturn: { min: number; max: number };
    monthlyContribution: { min: number; max: number };
  };
}

export interface SyncRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
  accountsSeen: number;
  snapshotsWritten: number;
  stale: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: Record<string, string>;

  constructor(status: number, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const body = text === "" ? null : JSON.parse(text);

  if (!response.ok) {
    const message = body?.error ?? `Request failed: ${response.status}`;
    throw new ApiError(response.status, message, body?.details ?? {});
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  summary: () => request<Summary>("/api/summary"),
  snapshots: () => request<SnapshotSeries>("/api/snapshots"),
  holdings: () => request<Holdings>("/api/holdings/latest"),
  contributions: () => request<{ contributions: Contribution[]; total: number; totalAllTime: number }>(
    "/api/contributions",
  ),
  projection: (params: { return?: number; monthly?: number; months?: number }) => {
    const query = new URLSearchParams();
    if (params.return !== undefined) query.set("return", String(params.return));
    if (params.monthly !== undefined) query.set("monthly", String(params.monthly));
    if (params.months !== undefined) query.set("months", String(params.months));
    return request<Projection>(`/api/projection?${query.toString()}`);
  },
  settings: () => request<Settings>("/api/settings"),
  accounts: () => request<AccountList>("/api/accounts"),
  setAccountScope: (accountId: string, inScope: boolean) =>
    request<{ account: Account }>(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify({ inScope }),
    }),
  syncRuns: () => request<{ runs: SyncRun[] }>("/api/sync/runs"),
  importSharesiesCsv: (input: {
    csv: string;
    filename?: string | null;
    mode?: "preview" | "apply";
    categories?: string[];
    dateFormat?: string;
  }) =>
    request<CsvImportResult>("/api/import/sharesies-csv", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  imports: () => request<{ imports: ImportRecord[] }>("/api/imports"),

  updateSettings: (patch: { annualReturn?: number; monthlyContribution?: number }) =>
    request<{ assumptions: Settings["assumptions"] }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  createGoal: (body: {
    name: string;
    targetAmountNzd: number;
    targetDate?: string | null;
    progressBasis?: "value" | "contributions";
    withPercentMilestones?: boolean;
  }) => post<{ goal: SummaryGoal; milestones: Milestone[] }>("/api/goals", body),

  updateGoal: (id: number, patch: Record<string, unknown>) =>
    request<{ goal: Milestone }>(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  createMilestone: (goalId: number, body: Record<string, unknown>) =>
    post<{ milestone: Milestone }>(`/api/goals/${goalId}/milestones`, body),

  deleteMilestone: (id: number) =>
    request<{ deleted: boolean }>(`/api/milestones/${id}`, { method: "DELETE" }),

  addContribution: (body: { contributionDate: string; amountNzd: number; note?: string }) =>
    post<{ contribution: Contribution }>("/api/contributions", body),

  deleteContribution: (id: number) =>
    request<{ deleted: boolean }>(`/api/contributions/${id}`, { method: "DELETE" }),

  setManualValue: (value: number) => post<{ manualValueNzd: number }>("/api/manual-value", { value, collect: true }),
  sync: () => post<{ result: { status: string; value: number | null; snapshotsWritten: number; error: string | null; warnings: string[] } }>("/api/sync"),
  refresh: () => post<{ refreshed: boolean; message?: string }>("/api/refresh", {}),
};

export const nzd = (value: number | null | undefined, options: { compact?: boolean } = {}): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: "NZD",
    ...(options.compact
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(value);
};

export const pct = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "–" : `${value.toFixed(digits)}%`;

export const shortDate = (value: string | null | undefined): string => {
  if (!value) return "–";
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(date);
};

export const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "never";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};
