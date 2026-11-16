// Checks .vercel/output/ without the vercel CLI: serves the bundled function with node:http on
// port 8794 and exercises the API, then checks the static app is there.
// Run with LLM_MODE=replay and no API key (the Makefile target does both).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel", "output");
const PORT = 8794;
const base = `http://127.0.0.1:${PORT}`;

if (process.env.LLM_MODE !== "replay") throw new Error("vercel-verify: run with LLM_MODE=replay");
if (process.env.ANTHROPIC_API_KEY) throw new Error("vercel-verify: unset ANTHROPIC_API_KEY");

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

for (const f of ["static/index.html", "config.json", "functions/api.func/.vc-config.json"]) {
  check(fs.existsSync(path.join(out, f)), `exists ${f}`);
}
const vc = JSON.parse(
  fs.readFileSync(path.join(out, "functions/api.func/.vc-config.json"), "utf8"),
);
check(vc.runtime === "nodejs22.x" && vc.handler === "index.mjs", ".vc-config.json runtime");

const mod = await import(pathToFileURL(path.join(out, "functions/api.func/index.mjs")).href);
const handler = mod.default;
check(typeof handler === "function", "default export is a request handler");

const server = http.createServer(handler);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});

async function req(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

try {
  const health = await req("GET", "/healthz");
  check(
    health.status === 200 &&
      health.json?.status === "ok" &&
      typeof health.json.version === "string",
    "GET /healthz",
    `status=${health.status} version=${health.json?.version}`,
  );
  check(health.json?.version !== "dev", "GIT_SHA baked into the API bundle");

  const docs = await req("GET", "/documents");
  const list = docs.json?.documents;
  check(
    docs.status === 200 && Array.isArray(list) && list.length >= 4,
    "GET /documents",
    `status=${docs.status} count=${list?.length}`,
  );

  const search = await req("GET", "/search?q=indemnify&expand=false");
  const results = search.json?.results;
  check(
    search.status === 200 && Array.isArray(results) && results.length > 0,
    "GET /search?q=indemnify&expand=false",
    `status=${search.status} results=${results?.length}`,
  );

  const doc = list?.[0];
  const full = doc ? await req("GET", `/documents/${doc.id}`) : { status: 0 };
  const text = full.json?.text ?? "";
  const target = text.split(/\s+/).find((w) => w.length > 0) ?? "x";
  const patch = await req("PATCH", `/documents/${doc?.id}?dryRun=true`, {
    changes: [{ operation: "replace", target: { text: target }, replacement: "DRAFT" }],
  });
  check(
    patch.status === 200 &&
      patch.json?.dryRun === true &&
      patch.json?.version === full.json?.version &&
      typeof patch.json?.text === "string" &&
      patch.json.text.includes("DRAFT") &&
      patch.json?.redline !== undefined,
    `PATCH /documents/${doc?.id}?dryRun=true`,
    `status=${patch.status} version=${patch.json?.version} dryRun=${patch.json?.dryRun}`,
  );
  const after = doc ? await req("GET", `/documents/${doc.id}`) : { status: 0 };
  check(after.json?.text === text, "dry run left the document unchanged");

  const missing = await req("GET", "/no-such-route");
  check(missing.status === 404, "unknown API path is 404", `status=${missing.status}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length > 0) {
  console.error(`vercel-verify: FAIL (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("vercel-verify: OK");
