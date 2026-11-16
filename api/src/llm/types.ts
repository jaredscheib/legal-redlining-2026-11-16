import type { ZodType } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCallInput<T> {
  /** Short operation name for logs and the ledger, e.g. "suggest" or "expand". */
  op: string;
  system: string;
  messages: LlmMessage[];
  schema: ZodType<T>;
  maxTokens: number;
  effort: Effort;
  timeoutMs: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmCallResult<T> {
  output: T;
  usage: LlmUsage;
  /** 0 for a replayed call. */
  costUsd: number;
  replayed: boolean;
}

/** The exact request that is hashed for the replay key and sent to the API. */
export interface CanonicalRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  /** JSON Schema derived from the zod schema. */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
}

export interface TransportResponse {
  /** Raw JSON text of the structured output. */
  text: string;
  /** Output already parsed with the request's zod schema, when the transport did it. */
  parsed?: unknown;
  stopReason: string | null;
  model: string;
  usage: LlmUsage;
}

/** One live round trip to the model. Swappable so tests never touch the network. */
export type LlmTransport = (
  req: CanonicalRequest,
  opts: { timeoutMs: number; schema: ZodType },
) => Promise<TransportResponse>;

export type LlmUnavailableReason =
  "no_api_key" | "no_recording" | "refusal" | "invalid_output" | "timeout" | "api_error";

export class LlmUnavailable extends Error {
  constructor(
    readonly reason: LlmUnavailableReason,
    message: string = reason,
  ) {
    super(message);
    this.name = "LlmUnavailable";
  }
}
