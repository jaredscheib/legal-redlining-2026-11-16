import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { ApiError } from "./errors.js";

type Target = "json" | "query" | "param";

/** zod validation that fails with 400 INVALID_PAYLOAD and the zod issues in details.issues. */
export function validate<T extends ZodType, K extends Target>(target: K, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ApiError(400, "INVALID_PAYLOAD", `Invalid ${target}`, {
        issues: result.error.issues,
      });
    }
  });
}
