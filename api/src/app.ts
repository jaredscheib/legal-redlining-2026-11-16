import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiError, onError, onNotFound } from "./errors.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSuggestionRoutes } from "./routes/suggestions.js";
import type { AppDeps } from "./routes/deps.js";
import { version } from "./version.js";

export type { AppDeps };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", version: version() }));

  registerDocumentRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerSuggestionRoutes(app, deps);

  app.notFound(onNotFound);
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
