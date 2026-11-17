import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "./log.js";
import { REQUEST_ID_HEADER, matchedRoute, newRequestId } from "./request-id.js";

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
  // The request-id middleware set the id and the log context (reqId); reuse them.
  const reqId = c.get("requestId") ?? newRequestId();
  log.error("http.unhandled", {
    reqId,
    method: c.req.method,
    route: matchedRoute(c),
    errorName: err.name,
  });
  c.header(REQUEST_ID_HEADER, reqId);
  const body: ErrorBody = { error: "Internal error", code: 500 };
  return c.json(body, 500);
}

/**
 * No handler matched. 405 METHOD_NOT_ALLOWED with an `Allow` header when the path is a known
 * route under other methods (`allowed`), else 404 ROUTE_NOT_FOUND.
 */
export function onNotFound(c: Context, allowed: readonly string[] = []): Response {
  if (allowed.length > 0) {
    c.header("Allow", allowed.join(", "));
    const body: ErrorBody = {
      error: `${c.req.method} is not allowed here; use ${allowed.join(", ")}`,
      code: 405,
      details: { reason: "METHOD_NOT_ALLOWED", allowed: [...allowed] },
    };
    return c.json(body, 405);
  }
  const body: ErrorBody = {
    error: "Route not found",
    code: 404,
    details: { reason: "ROUTE_NOT_FOUND" },
  };
  return c.json(body, 404);
}
