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

// session.subsystems should report the files subsystem ready.
const subs = await client.call("session.subsystems", {});
assert.ok(Array.isArray(subs.subsystems), "subsystems array");
const filesSub = subs.subsystems.find((s) => s.name === "files");
assert.ok(filesSub, "files subsystem registered");
assert.equal(filesSub.state, "ready", "files subsystem ready");
console.log(`[smoke] session.subsystems ok — ${subs.subsystems.map((s) => `${s.name}=${s.state}`).join(", ")}`);

// session.capabilities should now advertise the expanded method list.
const caps2 = await client.call("session.capabilities", {});
assert.ok(caps2.capabilities.methods.includes("files.read"), "files.read advertised");
assert.ok(caps2.capabilities.methods.includes("files.list"), "files.list advertised");
console.log(`[smoke] session.capabilities ok — ${caps2.capabilities.methods.length} methods`);

// files.list should find the repo root's README without descending into node_modules.
const listing = await client.call("files.list", { glob: "*.md" });
assert.ok(listing.paths.includes("README.md"), `README.md not found in listing: ${listing.paths.join(", ")}`);
assert.ok(!listing.paths.some((p) => p.includes("node_modules")), "node_modules leaked into listing");
console.log(`[smoke] files.list ok — ${listing.paths.length} entries (e.g. ${listing.paths.slice(0, 3).join(", ")})`);

// files.read should return the README content.
const readme = await client.call("files.read", { path: "README.md" });
assert.equal(readme.path, "README.md", "files.read echoes path");
assert.equal(readme.encoding, "utf8", "files.read default encoding");
assert.ok(readme.content.startsWith("# pi-webdev"), "README content matches");
assert.equal(readme.truncated, false, "README should fit under 1 MiB");
console.log(`[smoke] files.read ok — ${readme.byteLength}B of ${readme.path}`);

// Path traversal must be blocked.
try {
  await client.call("files.read", { path: "../etc/passwd" });
  throw new Error("path traversal should have been rejected");
} catch (err) {
  assert.equal(err.code, 10200, "InvalidArgument for traversal");
  console.log(`[smoke] path traversal correctly rejected (code ${err.code})`);
}

// Nonexistent file must NotFound.
try {
  await client.call("files.read", { path: "does/not/exist.txt" });
  throw new Error("missing file should have been NotFound");
} catch (err) {
  assert.equal(err.code, 10100, "NotFound for missing file");
  console.log(`[smoke] missing file correctly NotFound (code ${err.code})`);
}

await client.close();
await server.stop();
console.log("[smoke] foundation green ✓");
