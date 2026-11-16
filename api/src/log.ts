/**
 * JSONL logger: one object per line to stdout and data/app.log.
 * Log ids and counts only. Never document text, passages or query text.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { dataPath } from "./config.js";

type Value = string | number | boolean | null | undefined;
export type LogFields = Record<string, Value | Value[] | Record<string, Value>>;

let fileReady: boolean | undefined;

function appendToFile(line: string): void {
  if (process.env.LOG_FILE === "off") return;
  try {
    if (fileReady === undefined) {
      fs.mkdirSync(dataPath(), { recursive: true });
      fileReady = true;
    }
    fs.appendFileSync(dataPath("app.log"), line + "\n");
  } catch {
    fileReady = false; // the log file is best effort; stdout still has the line
  }
}

/** Fields every line inside a request carries, e.g. reqId. Set by the request-id middleware. */
export interface LogContext {
  reqId: string;
}

const context = new AsyncLocalStorage<LogContext>();

/** Runs `fn` so that every log line written inside it (across awaits) carries `ctx`. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run(ctx, fn);
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const ctx = context.getStore();
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...ctx, ...fields });
  if (process.env.LOG_STDOUT !== "off") process.stdout.write(line + "\n");
  if (fileReady !== false) appendToFile(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};
