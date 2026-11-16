/**
 * Defaults for the bundled Vercel function. Imported first by handler.ts, so it runs before
 * config.ts reads the environment. In the bundle, import.meta.url is api.func/index.mjs, so
 * the seed contracts and recordings resolve next to it. Explicit env always wins.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));

process.env.SEED_DIR ||= path.join(bundleDir, "seed");
process.env.FIXTURES_DIR ||= path.join(bundleDir, "fixtures", "llm");
/** The function's filesystem is read-only except /tmp. */
process.env.DATA_DIR ||= "/tmp/data";
/** stdout is the log; Vercel collects it. */
process.env.LOG_FILE ||= "off";
