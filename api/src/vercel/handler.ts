/**
 * Entry point of the Vercel function (bundled by scripts/vercel-build.sh). The runtime is
 * built once per instance, at module load: state lives in memory until the next cold start.
 */
import "./env.js";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../app.js";
import { log } from "../log.js";
import { createRuntime } from "../runtime.js";
import { version } from "../version.js";

const runtime = createRuntime();
const app = createApp(runtime.deps);

log.info("function.start", {
  version: version(),
  docs: runtime.seeded,
  llmMode: runtime.llmClient.mode,
});

export default getRequestListener(app.fetch);
