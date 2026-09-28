/**
 * Small hand-rolled validation. Keeps the dependency surface tiny and gives
 * every route the same error shape.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly details: Record<string, string>;

  constructor(status: number, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details: Record<string, string> = {}): HttpError {
  return new HttpError(400, message, details);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a JSON body, rejecting anything that is not an object. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (!isRecord(parsed)) throw badRequest("Request body must be a JSON object");
  return parsed;
}

export function reqString(
  body: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  const value = body[field];
  if (typeof value !== "string") throw badRequest(`${field} is required`, { [field]: "must be a string" });
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed === "") {
    throw badRequest(`${field} must not be empty`, { [field]: "must not be empty" });
  }
  if (options.maxLength && trimmed.length > options.maxLength) {
    throw badRequest(`${field} is too long`, { [field]: `max ${options.maxLength} characters` });
  }
  return trimmed;
}

export function optString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string or null`, { [field]: "invalid" });
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function reqNumber(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = body[field];
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw badRequest(`${field} must be a number`, { [field]: "must be a number" });
  }
  if (options.min !== undefined && parsed < options.min) {
    throw badRequest(`${field} must be at least ${options.min}`, { [field]: `min ${options.min}` });
  }
  if (options.max !== undefined && parsed > options.max) {
    throw badRequest(`${field} must be at most ${options.max}`, { [field]: `max ${options.max}` });
  }
  return parsed;
}

export function reqDate(body: Record<string, unknown>, field: string): string {
  const value = reqString(body, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${field} must be a YYYY-MM-DD date`, { [field]: "expected YYYY-MM-DD" });
  }
  return value;
}

export function optDate(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = optString(body, field);
  if (value === undefined || value === null) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${field} must be a YYYY-MM-DD date`, { [field]: "expected YYYY-MM-DD" });
  }
  return value;
}

export function optBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw badRequest(`${field} must be a boolean`, { [field]: "must be a boolean" });
}

export function reqId(value: string | undefined, field = "id"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`${field} must be a positive integer`, { [field]: "invalid" });
  }
  return parsed;
}

export function optEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of: ${allowed.join(", ")}`, { [field]: "invalid" });
  }
  return value as T;
}

/** Read an optional query parameter, treating "" as absent. */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.trim() === "" ? undefined : value.trim();
}

export function queryNumber(url: URL, name: string, fallback: number): number {
  const raw = queryParam(url, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`, { [name]: "invalid" });
  return parsed;
}
