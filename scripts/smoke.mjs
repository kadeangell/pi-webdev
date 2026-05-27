/**
 * End-to-end smoke test for the Phase 1 Week 1 foundation:
 *   - boots @pi-webdev/server on an ephemeral port
 *   - connects the @pi-webdev/coding-agent WDP client
 *   - handshake -> ping -> capabilities-readback
 *
 * If this exits 0, the foundation is alive. Run with `pnpm smoke`.
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { createServer } = require("./../packages/server/dist/index.js");
const { WdpClient } = require("./../packages/pi-extension/dist/client/index.js");

const server = await createServer({ port: 0, projectRoot: process.cwd() });
console.log(`[smoke] server listening at ${server.url}`);

const client = await WdpClient.connect({
  url: server.url,
  client: "pi-webdev-smoke",
  clientVersion: "0.1.0",
});

const caps = client.capabilitiesSnapshot();
assert.ok(caps, "capabilities snapshot missing");
assert.equal(caps.serverName, "@pi-webdev/server", "server name");
assert.ok(Array.isArray(caps.capabilities.methods), "methods list");
assert.ok(caps.capabilities.methods.includes("$/ping"), "$/ping advertised");
assert.ok(caps.capabilities.methods.includes("$/initialize"), "$/initialize advertised");
console.log(`[smoke] handshake ok — server ${caps.serverName}@${caps.serverVersion}, methods: ${caps.capabilities.methods.join(", ")}`);
console.log(`[smoke] framework detected: ${caps.capabilities.framework.detected} (${caps.capabilities.framework.version ?? "n/a"})`);

const t0 = performance.now();
const pong = await client.call("$/ping", { echo: "hello-foundation" });
const rttMs = performance.now() - t0;
assert.equal(pong.echo, "hello-foundation", "ping echo");
assert.ok(typeof pong.serverTime === "number", "ping serverTime");
console.log(`[smoke] $/ping echo="${pong.echo}" rtt=${rttMs.toFixed(2)}ms`);

// Bare ping (no echo).
const pong2 = await client.call("$/ping", {});
assert.equal(pong2.echo, undefined, "ping with no echo should omit echo");
console.log(`[smoke] $/ping (no echo) ok`);

// Second initialize must fail — guards against double-handshake.
try {
  await client.call("$/initialize", {
    client: "pi-webdev-smoke",
    supportedVersions: ["0.x"],
  });
  throw new Error("second $/initialize should have failed");
} catch (err) {
  assert.ok(err && err.name === "WdpError", `expected WdpError, got ${err?.name}`);
  assert.equal(err.code, -32003, "AlreadyInitialized");
  console.log(`[smoke] double-handshake correctly rejected (code ${err.code})`);
}

// Unknown method must return MethodNotFound.
try {
  await client.call("does.not.exist", {});
  throw new Error("unknown method should have failed");
} catch (err) {
  assert.equal(err.code, -32601, "MethodNotFound");
  console.log(`[smoke] unknown method correctly rejected (code ${err.code})`);
}

await client.close();
await server.stop();
console.log("[smoke] foundation green ✓");
