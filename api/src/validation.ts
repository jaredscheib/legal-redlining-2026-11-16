import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodType, core } from "zod";
import { ApiError } from "./errors.js";

type Target = "json" | "query" | "param";

/** What the root of each target is called in an error message. */
const ROOT_NAME: Record<Target, string> = { json: "body", query: "query", param: "path" };

/** `changes[0].target`: dotted keys, bracketed indexes. */
export function formatPath(path: readonly PropertyKey[], root: string): string {
  if (path.length === 0) return root;
  return path
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : `${i === 0 ? "" : "."}${String(seg)}`))
    .join("");
}

const quoteAll = (values: readonly unknown[]) => values.map((v) => JSON.stringify(v)).join(", ");

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** One zod issue as a short phrase, e.g. `must be at most 1000 characters`. */
export function describeIssue(issue: core.$ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys":
      return `unrecognized key${issue.keys.length === 1 ? "" : "s"} ${quoteAll(issue.keys)}`;
    case "invalid_type": {
      // zod reports what it received only in the message ("…, received undefined").
      const received = /received (\w+)/.exec(issue.message)?.[1];
      if (received === "undefined") return "is required";
      if (issue.expected === "int" && received === "number") return "must be an integer";
      const expected = issue.expected === "int" ? "an integer" : `a ${issue.expected}`;
      return received ? `must be ${expected}, not ${received}` : `must be ${expected}`;
    }
    case "invalid_value":
      return issue.values.length === 1
        ? `must be ${quoteAll(issue.values)}`
        : `must be one of ${quoteAll(issue.values)}`;
    case "too_big":
    case "too_small": {
      const big = issue.code === "too_big";
      const bound = Number(big ? issue.maximum : issue.minimum);
      if (issue.origin === "string") {
        if (!big && bound === 1) return "must not be empty";
        return `must be at ${big ? "most" : "least"} ${plural(bound, "character")}`;
      }
      if (issue.origin === "array") {
        return `must have at ${big ? "most" : "least"} ${plural(bound, "item")}`;
      }
      const strict = issue.inclusive === false;
      const op = big ? (strict ? "less than" : "at most") : strict ? "greater than" : "at least";
      return `must be ${op} ${bound}`;
    }
    case "invalid_union":
      return "does not match any allowed form";
    default:
      return issue.message;
  }
}

/** The first issue as `path: problem`, the `error` text of a 400 INVALID_PAYLOAD. */
export function issueSummary(issues: readonly core.$ZodIssue[], target: Target): string {
  const first = issues[0];
  if (!first) return `invalid ${ROOT_NAME[target]}`;
  return `${formatPath(first.path, ROOT_NAME[target])}: ${describeIssue(first)}`;
}

/**
 * `application/json`, optionally with parameters such as `; charset=utf-8`. The same pattern
 * Hono's validator reads a JSON body under, so a body this accepts is never silently ignored.
 */
const JSON_MEDIA_TYPE = /^application\/json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * 415 UNSUPPORTED_MEDIA_TYPE unless the body is declared `application/json`. A body sent with
 * no Content-Type is unsupported too; no body and no Content-Type falls through to the JSON
 * parse, which reports it.
 */
async function requireJsonMediaType(c: Context): Promise<void> {
  const contentType = c.req.header("content-type");
  if (contentType !== undefined && JSON_MEDIA_TYPE.test(contentType)) return;
  if (contentType === undefined && (await c.req.text()) === "") return;
  throw new ApiError(
    415,
    "UNSUPPORTED_MEDIA_TYPE",
    contentType === undefined
      ? "the request body needs Content-Type: application/json"
      : `Content-Type must be application/json, not ${contentType.split(";")[0]?.trim()}`,
  );
}

/**
 * Parses the JSON body up front so a syntax error gets its own message. Hono caches the
 * parsed body, so the validator after it does not parse again.
 */
async function parseJsonBody(c: Context): Promise<void> {
  try {
    await c.req.json();
  } catch {
    throw new ApiError(400, "INVALID_PAYLOAD", "request body is not valid JSON");
  }
}

/**
 * zod validation that fails with 400 INVALID_PAYLOAD: `error` names the first issue's path and
 * problem, and `details.issues` has every zod issue. For a JSON body the media type is checked
 * first (415) and then the syntax (400).
 */
export function validate<T extends ZodType, K extends Target>(target: K, schema: T) {
  const check = zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ApiError(400, "INVALID_PAYLOAD", issueSummary(result.error.issues, target), {
        issues: result.error.issues,
      });
    }
  });
  if (target !== "json") return check;
  const withBody: typeof check = async (c, next) => {
    await requireJsonMediaType(c);
    await parseJsonBody(c);
    return check(c, next);
  };
  return withBody;
}
