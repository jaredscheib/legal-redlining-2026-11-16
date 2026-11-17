/**
 * Record/replay cassettes so repeated calls never hit the API.
 * A cassette is api/fixtures/llm/<key>.json, keyed by a sha256 of the canonical request.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanonicalRequest, LlmUsage, TransportResponse } from "./types.js";

export interface Cassette {
  key: string;
  op: string;
  model: string;
  request: CanonicalRequest;
  response: Pick<TransportResponse, "text" | "stopReason" | "model">;
  usage: LlmUsage;
  recordedAt: string;
}

/** JSON with object keys sorted at every depth, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function cassetteKey(req: CanonicalRequest): string {
  const { model, system, messages, schema, maxTokens, effort, thinking } = req;
  // An unset `thinking` is left out of the JSON, so a request without it keys the same as one
  // that never had the field.
  return createHash("sha256")
    .update(canonicalJson({ model, system, messages, schema, maxTokens, effort, thinking }))
    .digest("hex");
}

export class CassetteStore {
  constructor(readonly dir: string) {}

  private file(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid cassette key");
    return path.join(this.dir, `${key}.json`);
  }

  read(key: string): Cassette | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(key), "utf8")) as Cassette;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  write(cassette: Cassette): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(cassette.key);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cassette, null, 2) + "\n");
    fs.renameSync(tmp, target);
  }
}
