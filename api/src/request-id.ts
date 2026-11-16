/**
 * Request ids: accept a short, safe incoming x-request-id or mint one, echo it on every
 * response, run the request inside a log context so every line carries reqId, and write one
 * http.request access line. Logs the matched route pattern, never the raw path or query.
 */
import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { elapsedMs, log, withLogContext } from "./log.js";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

export function acceptRequestId(incoming: string | undefined): string {
  return incoming !== undefined && SAFE_ID.test(incoming) ? incoming : newRequestId();
}

/** The registered pattern of the handler that answered, e.g. /documents/:id; never the raw path. */
export function matchedRoute(c: Context): string {
  const handlers = matchedRoutes(c).filter((r) => r.method !== "ALL");
  return handlers[handlers.length - 1]?.path ?? "unmatched";
}

export const requestId = (): MiddlewareHandler => async (c, next) => {
  const reqId = acceptRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set("requestId", reqId);
  const t0 = performance.now();
  await withLogContext({ reqId }, async () => {
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, reqId);
    log.info("http.request", {
      method: c.req.method,
      route: matchedRoute(c),
      status: c.res.status,
      ms: elapsedMs(t0),
    });
  });
};
