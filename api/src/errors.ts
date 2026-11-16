import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "./log.js";

/** Error body for every non-2xx response. `code` is the HTTP status. */
export interface ErrorBody {
  error: string;
  code: number;
  details?: { reason: string } & Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    /** UPPER_SNAKE machine-readable reason, e.g. DOCUMENT_NOT_FOUND. */
    readonly reason: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (reason: string, message: string) => new ApiError(404, reason, message);
export const notImplemented = (what: string) =>
  new ApiError(501, "NOT_IMPLEMENTED", `${what} is not implemented yet`);

export function errorBody(err: ApiError): ErrorBody {
  return {
    error: err.message,
    code: err.status,
    details: { ...err.details, reason: err.reason },
  };
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json(errorBody(err), err.status);
  }
  const requestId = crypto.randomUUID();
  log.error("http.unhandled", {
    requestId,
    method: c.req.method,
    route: c.req.routePath,
    errorName: err.name,
  });
  c.header("x-request-id", requestId);
  const body: ErrorBody = { error: "Internal error", code: 500 };
  return c.json(body, 500);
}

export function onNotFound(c: Context): Response {
  const body: ErrorBody = {
    error: "Route not found",
    code: 404,
    details: { reason: "ROUTE_NOT_FOUND" },
  };
  return c.json(body, 404);
}
