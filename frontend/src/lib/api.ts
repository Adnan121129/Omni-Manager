/**
 * Thin fetch wrapper for the Django API. Uses the session cookie and echoes the CSRF token,
 * and normalises the backend's error envelope into ApiError.
 */

const CSRF_COOKIE = "om_csrftoken";

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string[]>;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, fields: Record<string, string[]> = {}, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }

  /** First field error, or the main message. */
  get summary(): string {
    const first = Object.values(this.fields)[0];
    if (this.code === "validation_error" && first?.length) return first[0];
    return this.message;
  }
}

export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

let csrfPromise: Promise<void> | null = null;

async function ensureCsrf(): Promise<string | null> {
  let token = readCookie(CSRF_COOKIE);
  if (token) return token;
  csrfPromise ??= fetch("/api/auth/csrf/", { credentials: "same-origin" }).then(() => undefined);
  await csrfPromise;
  csrfPromise = null;
  token = readCookie(CSRF_COOKIE);
  return token;
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function flattenFields(fields: unknown): Record<string, string[]> {
  if (!fields || typeof fields !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    else if (typeof value === "string") out[key] = [value];
    else out[key] = [JSON.stringify(value)];
  }
  return out;
}

async function request<T>(method: string, path: string, body?: Body, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (method !== "GET") {
    const token = await ensureCsrf();
    if (token) headers["X-CSRFToken"] = token;
  }
  let response: Response;
  try {
    response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
  }
  if (response.status === 204) return undefined as T;
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const err = data?.error;
    if (err) throw new ApiError(response.status, err.code ?? "error", err.message ?? "Request failed", flattenFields(err.fields), err.details);
    const fallback = response.status === 403 ? "You don't have permission to do that." : response.status >= 500 ? "Something went wrong on our side. Please try again." : "Request failed.";
    throw new ApiError(response.status, response.status === 404 ? "not_found" : "error", fallback);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  post: <T>(path: string, body?: Body, options?: RequestOptions) => request<T>("POST", path, body ?? {}, options),
  patch: <T>(path: string, body?: Body, options?: RequestOptions) => request<T>("PATCH", path, body ?? {}, options),
  put: <T>(path: string, body?: Body, options?: RequestOptions) => request<T>("PUT", path, body ?? {}, options),
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>("DELETE", path, undefined, options),
};

export interface Paginated<T> {
  results: T[];
  count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.summary;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
