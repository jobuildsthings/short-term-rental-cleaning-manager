/**
 * Shared API-route helpers (Workstream B).
 *
 * Error shape follows the contracts: {error: {code, message}}.
 * 500s never leak internals — and never log request bodies, which may
 * contain feed URLs or other secrets.
 */
import { AuthError, authErrorResponse } from "./auth-helpers";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(entity = "Not found"): ApiError {
  return new ApiError(404, "not_found", entity);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

export function forbidden(message = "Not allowed."): ApiError {
  return new ApiError(403, "forbidden", message);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export function assertDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) {
    throw badRequest(`${field} must be a YYYY-MM-DD date`);
  }
  return v;
}

export function assertTime(v: unknown, field: string): string {
  if (typeof v !== "string" || !TIME_RE.test(v)) {
    throw badRequest(`${field} must be an HH:MM time`);
  }
  return v.length === 5 ? `${v}:00` : v;
}

export function apiErrorResponse(e: unknown): Response {
  if (e instanceof AuthError) return authErrorResponse(e);
  if (e instanceof ApiError) {
    return Response.json(
      { error: { code: e.code, message: e.message } },
      { status: e.status },
    );
  }
  console.error("unhandled route error:", e instanceof Error ? e.message : e);
  return Response.json(
    { error: { code: "internal", message: "Something went wrong." } },
    { status: 500 },
  );
}
