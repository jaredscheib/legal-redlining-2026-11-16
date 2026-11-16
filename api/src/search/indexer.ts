/**
 * Builds document segments: in a worker thread (default) or synchronously on the caller's
 * thread (SEARCH_INDEX_WORKER=off, or when a worker cannot start).
 */
import type { Worker as WorkerType } from "node:worker_threads";
import { SEARCH_INDEX_WORKER } from "../config.js";
import { log } from "../log.js";
import type { IndexRequest } from "./index-worker.js";
import { buildSegment, type Segment } from "./segment.js";

export type IndexMode = "worker" | "sync";

export interface BuiltSegment {
  segment: Segment;
  /** Time spent splitting and tokenizing, wherever it ran. */
  buildMs: number;
  mode: IndexMode;
}

export interface Indexer {
  readonly mode: IndexMode;
  build(doc: { id: string; version: number; text: string }): Promise<BuiltSegment>;
  close(): void;
}

export function createSyncIndexer(): Indexer {
  return {
    mode: "sync",
    build: async (doc) => {
      const t0 = performance.now();
      const segment = buildSegment(doc.text);
      return { segment, buildMs: performance.now() - t0, mode: "sync" };
    },
    close: () => {},
  };
}

/**
 * The worker script next to this module: index-worker.ts under tsx/vitest (loaded through
 * tsx), index-worker.js in dist/, index-worker.mjs next to the Vercel bundle's index.mjs.
 */
export function workerEntry(here: string = import.meta.url): { url: URL; execArgv: string[] } {
  const ext = /\.(ts|mjs|js)$/.exec(here)?.[1] ?? "js";
  return {
    url: new URL(`./index-worker.${ext}`, here),
    execArgv: ext === "ts" ? ["--import", "tsx"] : [],
  };
}

type Reply =
  | { reqId: number; id: string; version: number; buildMs: number; segment: Segment }
  | { reqId: number; error: string };

/**
 * One lazily started worker, unref'd so it never keeps the process alive. If it cannot start
 * or dies, pending builds (and later ones) run synchronously instead, and the result says so.
 */
export function createWorkerIndexer(
  entry: { url: URL; execArgv: string[] } = workerEntry(),
): Indexer {
  const sync = createSyncIndexer();
  let worker: WorkerType | null = null;
  let broken = false;
  let nextReq = 1;
  const waiting = new Map<
    number,
    { resolve: (r: BuiltSegment) => void; reject: (e: Error) => void }
  >();

  const failAll = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    worker = null;
  };

  const start = async (): Promise<WorkerType | null> => {
    if (worker) return worker;
    if (broken) return null;
    try {
      const { Worker } = await import("node:worker_threads");
      const { url, execArgv } = entry;
      const w = new Worker(url, { execArgv });
      w.on("message", (msg: Reply) => {
        const pending = waiting.get(msg.reqId);
        if (!pending) return;
        waiting.delete(msg.reqId);
        if ("error" in msg) pending.reject(new Error(msg.error));
        else pending.resolve({ segment: msg.segment, buildMs: msg.buildMs, mode: "worker" });
      });
      w.on("error", (err) => {
        log.warn("search.index_worker_error", { reason: err.name });
        failAll(err);
      });
      w.on("exit", () => {
        if (worker === w) failAll(new Error("worker_exited"));
      });
      // After the listeners: attaching a "message" listener refs the worker again.
      w.unref();
      worker = w;
      return w;
    } catch (err) {
      broken = true;
      log.warn("search.index_worker_unavailable", {
        reason: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
  };

  return {
    mode: "worker",
    async build(doc) {
      const w = await start();
      if (!w) return sync.build(doc);
      try {
        return await new Promise<BuiltSegment>((resolve, reject) => {
          const reqId = nextReq++;
          waiting.set(reqId, { resolve, reject });
          const req: IndexRequest = { reqId, id: doc.id, version: doc.version, text: doc.text };
          w.postMessage(req);
        });
      } catch (err) {
        log.warn("search.index_worker_fallback", {
          docId: doc.id,
          version: doc.version,
          reason: err instanceof Error ? err.message : "unknown",
        });
        return sync.build(doc);
      }
    },
    close() {
      const w = worker;
      worker = null;
      broken = true;
      if (w) void w.terminate();
      failAll(new Error("closed"));
    },
  };
}

export function createIndexer(mode: IndexMode = SEARCH_INDEX_WORKER ? "worker" : "sync"): Indexer {
  return mode === "worker" ? createWorkerIndexer() : createSyncIndexer();
}
