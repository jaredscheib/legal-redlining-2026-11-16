/**
 * JSONL logger: one object per line to stdout and data/app.log.
 * Log ids and counts only. Never document text, passages or query text.
 */
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

function write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (process.env.LOG_STDOUT !== "off") process.stdout.write(line + "\n");
  if (fileReady !== false) appendToFile(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};
