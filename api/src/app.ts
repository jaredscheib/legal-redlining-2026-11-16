import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiError, onError, onNotFound } from "./errors.js";
import { requestId } from "./request-id.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSuggestionRoutes } from "./routes/suggestions.js";
import type { AppDeps } from "./routes/deps.js";
import { version } from "./config.js";

export type { AppDeps };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", requestId());

  app.get("/healthz", (c) => c.json({ status: "ok", version: version() }));

  registerDocumentRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerSuggestionRoutes(app, deps);

  app.notFound((c) => onNotFound(c, allowedMethods(app, c.req.path)));
  app.onError((err, c) => {
    // Hono raises HTTPException for framework-level failures such as malformed JSON.
    if (err instanceof HTTPException && err.status < 500) {
      const reason = err.status === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR";
      return onError(new ApiError(err.status, reason, err.message || "Bad request"), c);
    }
    return onError(err, c);
  });

  return app;
}

/** `/documents/:id` as an exact-match RegExp: each `:param` is one non-empty path segment. */
function pathPattern(routePath: string): RegExp {
  const source = routePath
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

/**
 * The methods registered for `path`, read from the app's own route table so it is the one
 * source of truth. HEAD is listed wherever GET is, since Hono answers HEAD with the GET route.
 * Empty when no route matches the path under any method.
 */
export function allowedMethods(app: Hono, path: string): string[] {
  const methods = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue; // middleware such as the request id
    if (pathPattern(route.path).test(path)) methods.add(route.method);
  }
  if (methods.has("GET")) methods.add("HEAD");
  return [...methods].sort();
}
