/**
 * The single path to the model: record/replay cassettes, spend ledger and llm.call logs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { LLM_MODEL, PATHS, llmMode, type LlmMode } from "../config.js";
import { log } from "../log.js";
import { appendLedger, costUsd, defaultLedgerPath } from "./ledger.js";
import { CassetteStore, cassetteKey } from "./replay.js";
import {
  LlmUnavailable,
  type CanonicalRequest,
  type LlmCallInput,
  type LlmCallResult,
  type LlmTransport,
  type TransportResponse,
} from "./types.js";

export interface LlmClientOptions {
  mode?: LlmMode;
  /** Defaults to the Anthropic SDK; tests pass a fake. */
  transport?: LlmTransport;
  fixturesDir?: string;
  ledgerPath?: string;
  model?: string;
}

export interface LlmStats {
  liveCalls: number;
  replayedCalls: number;
  failedCalls: number;
  costUsd: number;
}

export interface LlmClient {
  readonly mode: LlmMode;
  call<T>(input: LlmCallInput<T>): Promise<LlmCallResult<T>>;
  stats(): LlmStats;
}

export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  return zodOutputFormat(schema).schema as Record<string, unknown>;
}

/**
 * Live transport over the SDK. The Anthropic client is built on first use, so a process
 * without ANTHROPIC_API_KEY can still serve replays.
 */
export function createSdkTransport(): LlmTransport {
  let client: Anthropic | undefined;
  return async (req, { timeoutMs, schema }) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new LlmUnavailable("no_api_key", "ANTHROPIC_API_KEY is not set");
    }
    client ??= new Anthropic();
    try {
      // Sonnet 5.5: adaptive thinking is on by default (omit `thinking`; "disabled" is a 400).
      // Depth is set with output_config.effort. No temperature/top_p.
      // `create`, not `parse`: parse throws on a refusal or a schema miss before we can read
      // `usage`, and those calls are still billed. The client parses and bills every response.
      // No SDK retries, so one call is one billed request and one ledger line.
      const response = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          output_config: {
            effort: req.effort,
            format: { type: "json_schema", schema: jsonSchemaOf(schema) },
          },
        },
        { timeout: timeoutMs, maxRetries: 0 },
      );
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const u = response.usage;
      return {
        text,
        parsed: undefined,
        stopReason: response.stop_reason ?? "unknown",
        refusalCategory: response.stop_details?.category ?? undefined,
        model: response.model,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof LlmUnavailable) throw err;
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new LlmUnavailable("timeout", `no response within ${timeoutMs} ms`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LlmUnavailable("api_error", `API error ${err.status ?? "?"}`);
      }
      throw err;
    }
  };
}

function parseOutput<T>(schema: ZodType<T>, text: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LlmUnavailable("invalid_output", "model output is not JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new LlmUnavailable("invalid_output", "model output fails schema");
  return parsed.data;
}

export function createLlmClient(opts: LlmClientOptions = {}): LlmClient {
  const mode = opts.mode ?? llmMode();
  const model = opts.model ?? LLM_MODEL;
  const cassettes = new CassetteStore(opts.fixturesDir ?? PATHS.fixturesDir);
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
  let transport = opts.transport;
  const stats: LlmStats = { liveCalls: 0, replayedCalls: 0, failedCalls: 0, costUsd: 0 };

  async function call<T>(input: LlmCallInput<T>): Promise<LlmCallResult<T>> {
    const started = performance.now();
    const request: CanonicalRequest = {
      model,
      system: input.system,
      messages: input.messages,
      schema: jsonSchemaOf(input.schema),
      maxTokens: input.maxTokens,
      effort: input.effort,
    };
    const key = cassetteKey(request);
    const done = (status: string, replayed: boolean, usage?: TransportResponse["usage"]) =>
      log.info("llm.call", {
        op: input.op,
        model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ms: Math.round(performance.now() - started),
        replayed,
        status,
        key: key.slice(0, 12),
      });

    try {
      if (mode !== "live") {
        const hit = cassettes.read(key);
        if (hit) {
          const output = parseOutput(input.schema, hit.response.text);
          stats.replayedCalls++;
          done("ok", true, hit.usage);
          return { output, usage: hit.usage, costUsd: 0, replayed: true };
        }
        if (mode === "replay") {
          throw new LlmUnavailable("no_recording", `no cassette for ${input.op} (${key})`);
        }
      }

      transport ??= createSdkTransport();
      const response = await transport(request, {
        timeoutMs: input.timeoutMs,
        schema: input.schema,
      });
      const cost = costUsd(response.usage);
      stats.liveCalls++;
      stats.costUsd += cost;
      // Bill first: the tokens are spent even if the output turns out to be unusable.
      appendLedger(
        {
          ts: new Date().toISOString(),
          op: input.op,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          costUsd: cost,
        },
        ledgerPath,
      );
      if (response.stopReason === "refusal") {
        throw new LlmUnavailable(
          "refusal",
          `model declined (${response.refusalCategory ?? "unspecified"})`,
        );
      }
      const output =
        response.parsed !== undefined
          ? (response.parsed as T)
          : parseOutput(input.schema, response.text);
      if (mode === "record") {
        cassettes.write({
          key,
          op: input.op,
          model,
          request,
          response: { text: response.text, stopReason: response.stopReason, model: response.model },
          usage: response.usage,
          recordedAt: new Date().toISOString(),
        });
      }
      done("ok", false, response.usage);
      return { output, usage: response.usage, costUsd: cost, replayed: false };
    } catch (err) {
      stats.failedCalls++;
      done(err instanceof LlmUnavailable ? err.reason : "error", false);
      throw err;
    }
  }

  return { mode, call, stats: () => ({ ...stats }) };
}
