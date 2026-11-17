import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatPath, issueSummary } from "./validation.js";

const summary = (schema: z.ZodType, value: unknown, target: "json" | "query" = "json") => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected a failure");
  return issueSummary(result.error.issues, target);
};

describe("formatPath", () => {
  it("dots keys and brackets indexes, and names the root when the path is empty", () => {
    expect(formatPath(["changes", 0, "target"], "body")).toBe("changes[0].target");
    expect(formatPath([], "query")).toBe("query");
  });
});

describe("issueSummary names the first issue's path and problem", () => {
  it.each<[string, z.ZodType, unknown, string]>([
    [
      "an unknown key",
      z.strictObject({ a: z.strictObject({ occurrence: z.number().optional() }) }),
      { a: { occurence: 3 } },
      'a: unrecognized key "occurence"',
    ],
    ["a missing field", z.object({ title: z.string() }), {}, "title: is required"],
    [
      "a wrong type",
      z.object({ title: z.string() }),
      { title: 3 },
      "title: must be a string, not number",
    ],
    ["a fraction", z.object({ n: z.number().int() }), { n: 0.5 }, "n: must be an integer"],
    [
      "a long string",
      z.object({ instruction: z.string().max(1000) }),
      { instruction: "x".repeat(1001) },
      "instruction: must be at most 1000 characters",
    ],
    [
      "an empty string",
      z.object({ text: z.string().min(1) }),
      { text: "" },
      "text: must not be empty",
    ],
    [
      "too few items",
      z.object({ changes: z.array(z.number()).min(1) }),
      { changes: [] },
      "changes: must have at least 1 item",
    ],
    [
      "a small number",
      z.object({ limit: z.number().min(1) }),
      { limit: 0 },
      "limit: must be at least 1",
    ],
    [
      "a bad enum value",
      z.object({ dryRun: z.enum(["true", "false"]) }),
      { dryRun: "yes" },
      'dryRun: must be one of "true", "false"',
    ],
    [
      "a refinement",
      z.object({ r: z.number().refine((n) => n > 0, { message: "must be positive" }) }),
      { r: -1 },
      "r: must be positive",
    ],
  ])("%s", (_name, schema, value, expected) => {
    expect(summary(schema, value)).toBe(expected);
  });

  it("names the root for an issue on the whole body or query", () => {
    expect(summary(z.strictObject({}), { x: 1 })).toBe('body: unrecognized key "x"');
    expect(summary(z.strictObject({}), { x: 1, y: 2 }, "query")).toBe(
      'query: unrecognized keys "x", "y"',
    );
  });
});
