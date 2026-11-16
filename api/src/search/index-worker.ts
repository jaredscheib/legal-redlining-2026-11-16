/**
 * Worker-thread entry: builds a document's segment (passage split + tokenize) off the main
 * thread. Receives {reqId, id, version, text}; replies {reqId, id, version, buildMs, segment}
 * with the segment's buffers transferred, or {reqId, error}. Bundled as its own entry for
 * Vercel (scripts/vercel-build.sh), next to index.mjs.
 */
import { parentPort } from "node:worker_threads";
import { buildSegment, segmentTransferList } from "./segment.js";

export interface IndexRequest {
  reqId: number;
  id: string;
  version: number;
  text: string;
}

parentPort?.on("message", (req: IndexRequest) => {
  try {
    const t0 = performance.now();
    const segment = buildSegment(req.text);
    const buildMs = performance.now() - t0;
    parentPort?.postMessage(
      { reqId: req.reqId, id: req.id, version: req.version, buildMs, segment },
      segmentTransferList(segment),
    );
  } catch (err) {
    parentPort?.postMessage({
      reqId: req.reqId,
      error: err instanceof Error ? err.name : "index_failed",
    });
  }
});
