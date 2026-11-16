import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { PORT } from "./config.js";
import { log } from "./log.js";
import { InMemoryDocumentStore } from "./store/memory.js";
import { seedStore } from "./store/seed.js";
import { version } from "./version.js";

const store = new InMemoryDocumentStore();
const docs = seedStore(store);
const app = createApp({ store });

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  log.info("server.start", { version: version(), port: info.port, docs });
});

function shutdown(signal: string): void {
  log.info("server.stop", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
