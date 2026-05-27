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
import { createServer as createHttp } from "node:http";

const require = createRequire(import.meta.url);
const { createServer } = require("./../packages/server/dist/index.js");
const { WdpClient } = require("./../packages/pi-extension/dist/client/index.js");

// Spin up a tiny page so the browser subsystem has something to navigate to.
const PAGE_HTML = `<!doctype html>
<html><head><title>smoke page</title></head>
<body>
  <h1 id="t">smoke</h1>
  <p>start</p>
  <button id="btn" onclick="document.getElementById('t').textContent = 'clicked'">go</button>
  <input id="name" />
  <output id="echo"></output>
  <script>
    document.getElementById('name').addEventListener('input', (e) => {
      document.getElementById('echo').textContent = 'hello ' + e.target.value;
    });
    console.log('smoke page boot');
  </script>
</body></html>`;
const fixture = createHttp((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
console.log(`[smoke] fixture page at ${fixtureUrl}`);

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

// files.write round-trip: write a scratch file under a tmp dir, read it back.
const scratchPath = `.smoke-tmp/hello.txt`;
const scratchBody = `hello at ${new Date().toISOString()}`;
const writeResult = await client.call("files.write", {
  path: scratchPath,
  content: scratchBody,
  createDirs: true,
});
assert.equal(writeResult.bytesWritten, Buffer.byteLength(scratchBody, "utf8"), "write byte count");
assert.ok(writeResult.path.endsWith("hello.txt"), "write echoes relative path");
const readBack = await client.call("files.read", { path: scratchPath });
assert.equal(readBack.content, scratchBody, "round-trip content");
console.log(`[smoke] files.write round-trip ok — ${writeResult.bytesWritten}B at ${writeResult.path}`);

// Path traversal must be blocked on write too.
try {
  await client.call("files.write", { path: "../escape.txt", content: "nope" });
  throw new Error("write traversal should have been rejected");
} catch (err) {
  assert.equal(err.code, 10200, "InvalidArgument for write traversal");
  console.log(`[smoke] files.write traversal correctly rejected (code ${err.code})`);
}

// Week 3 — file watcher event broadcast.
{
  const observed = [];
  const unsub = client.on("files.changed", (params) => {
    if (params?.entries) observed.push(...params.entries);
  });
  await client.call("files.write", { path: ".smoke-tmp/watcher-probe.txt", content: "hello watcher", createDirs: true });
  // Wait up to 1.5s for the chokidar event to flush.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && !observed.some((e) => e.path.endsWith("watcher-probe.txt"))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  unsub();
  const hit = observed.find((e) => e.path.endsWith("watcher-probe.txt"));
  assert.ok(hit, `expected files.changed for watcher-probe.txt; got ${JSON.stringify(observed)}`);
  console.log(`[smoke] files.changed event ok — ${hit.kind} ${hit.path}`);
}

// Week 3 — files.changedSince ring-buffer query.
{
  const since = new Date(Date.now() - 60_000).toISOString();
  const r = await client.call("files.changedSince", { since });
  assert.ok(Array.isArray(r.changes), "changedSince returns changes array");
  assert.ok(r.changes.some((e) => e.path.endsWith("watcher-probe.txt")), "watcher-probe in changedSince");
  console.log(`[smoke] files.changedSince ok — ${r.changes.length} change(s), cursor=${r.cursor}`);
}

// Week 3 — files.depGraph on the smoke script itself (a single-file module).
{
  // Write a tiny test entry so we don't depend on existing fixtures' install state.
  await client.call("files.write", {
    path: ".smoke-tmp/dep-a.js",
    content: "export const a = 1; import { b } from './dep-b.js'; console.log(a, b);",
    createDirs: true,
  });
  await client.call("files.write", {
    path: ".smoke-tmp/dep-b.js",
    content: "export const b = 2;",
    createDirs: true,
  });
  const r = await client.call("files.depGraph", { entry: ".smoke-tmp/dep-a.js" });
  assert.ok(r.graph.nodes.length >= 2, `expected ≥2 nodes; got ${r.graph.nodes.length}`);
  assert.ok(
    r.graph.edges.some((e) => e.to.includes("dep-b") || e.from.includes("dep-a")),
    `expected edge involving dep-b; got ${JSON.stringify(r.graph.edges)}`,
  );
  console.log(`[smoke] files.depGraph ok — ${r.graph.nodes.length} nodes, ${r.graph.edges.length} edges`);
}

// Week 4 — env.digestSinceLastTurn captures recent file changes.
{
  const since = new Date(Date.now() - 60_000).toISOString();
  const digest = await client.call("env.digestSinceLastTurn", { since });
  assert.ok(Array.isArray(digest.summary), "digest.summary array");
  const filesRow = digest.summary.find((r) => r.domain === "files");
  assert.ok(filesRow, `expected files row in digest summary; got ${JSON.stringify(digest.summary)}`);
  assert.ok(digest.text.startsWith("ENVIRONMENT EVENTS"), `digest text header missing: ${digest.text.slice(0, 80)}`);
  console.log(`[smoke] env.digestSinceLastTurn ok — ${digest.summary.length} row(s), ${digest.text.length} chars`);
}

// Week 4 — env.detectFramework returns the cached capability.
{
  const r = await client.call("env.detectFramework", {});
  assert.ok(r.framework, "framework returned");
  console.log(`[smoke] env.detectFramework ok — ${r.framework.detected}`);
}

// Week 3 — build.status disconnected (no Vite running in smoke env).
{
  const status = await client.call("build.status", {});
  assert.equal(status.adapter, "vite", "build.status adapter");
  assert.ok(["disconnected", "error", "connecting"].includes(status.state), `state was ${status.state}`);
  console.log(`[smoke] build.status ok — ${status.state} (no vite running, as expected)`);
}

// Week 5 — tsserver-backed types.diagnostics.
if (caps.capabilities.methods.includes("types.diagnostics")) {
  // Write a tiny .ts file with a deliberate type error.
  await client.call("files.write", {
    path: ".smoke-tmp/types-probe.ts",
    content: "const n: number = 'not-a-number';\nexport {};\n",
    createDirs: true,
  });
  const diag = await client.call("types.diagnostics", { files: [".smoke-tmp/types-probe.ts"] });
  assert.ok(Array.isArray(diag.diagnostics), "diagnostics array");
  const semantic = diag.diagnostics.find((d) => d.code === 2322); // TS2322 "Type X is not assignable to Y"
  assert.ok(semantic, `expected TS2322; got ${JSON.stringify(diag.diagnostics)}`);
  console.log(`[smoke] types.diagnostics ok — ${diag.diagnostics.length} diag(s), top: ${semantic.text.slice(0, 80)}`);
} else {
  console.log("[smoke] tsserver subsystem not registered — skipping types flow");
}

// Browser subsystem checks — skipped if Lightpanda wasn't detected at startup.
const hasBrowser = caps.capabilities.methods.includes("browser.navigate");
if (!hasBrowser) {
  console.log("[smoke] browser subsystem not registered (lightpanda not in PATH) — skipping browser flow");
} else {
  console.log(`[smoke] browser engine: ${caps.capabilities.browser.engine}` +
    (caps.capabilities.browser.version ? ` ${caps.capabilities.browser.version}` : ""));

  const session = await client.call("session.create", { url: fixtureUrl });
  assert.ok(session.sessionId, "session created");
  console.log(`[smoke] session.create ok — ${session.sessionId}`);

  const sessions = await client.call("session.list", {});
  assert.ok(sessions.sessions.some((s) => s.sessionId === session.sessionId), "session in list");

  // Evaluate document.title.
  const titleEval = await client.call("browser.eval", {
    sessionId: session.sessionId,
    expression: "document.title",
  });
  assert.equal(titleEval.result, "smoke page", `title eval: got ${JSON.stringify(titleEval)}`);
  console.log(`[smoke] browser.eval title="${titleEval.result}"`);

  // Read DOM as text.
  const dom = await client.call("browser.dom", { sessionId: session.sessionId, mode: "text" });
  assert.ok(dom.text && dom.text.includes("smoke"), `dom text missing 'smoke': ${dom.text}`);
  console.log(`[smoke] browser.dom text=${JSON.stringify(dom.text).slice(0, 60)}`);

  // Click the button and verify state mutation.
  await client.call("browser.click", { sessionId: session.sessionId, selector: "#btn" });
  const afterClick = await client.call("browser.eval", {
    sessionId: session.sessionId,
    expression: "document.getElementById('t').textContent",
  });
  assert.equal(afterClick.result, "clicked", `click did not mutate: ${JSON.stringify(afterClick)}`);
  console.log(`[smoke] browser.click + verify ok — h1 now "${afterClick.result}"`);

  // Fill an input and verify the input event handler ran.
  await client.call("browser.fill", { sessionId: session.sessionId, selector: "#name", value: "world" });
  const afterFill = await client.call("browser.eval", {
    sessionId: session.sessionId,
    expression: "document.getElementById('echo').textContent",
  });
  assert.equal(afterFill.result, "hello world", `fill did not propagate: ${JSON.stringify(afterFill)}`);
  console.log(`[smoke] browser.fill + verify ok — echo="${afterFill.result}"`);

  // Console capture: page logs "smoke page boot" on load.
  const consoleEntries = await client.call("browser.console", { sessionId: session.sessionId });
  const sawBoot = consoleEntries.entries.some((e) => e.text.includes("smoke page boot"));
  assert.ok(sawBoot, `expected console boot line, got ${JSON.stringify(consoleEntries.entries)}`);
  console.log(`[smoke] browser.console captured ${consoleEntries.entries.length} entry/entries`);

  // Selector miss returns NotFound on click.
  try {
    await client.call("browser.click", { sessionId: session.sessionId, selector: "#does-not-exist" });
    throw new Error("missing selector click should have failed");
  } catch (err) {
    assert.equal(err.code, 10100, "NotFound for missing selector");
    console.log(`[smoke] missing selector correctly NotFound (code ${err.code})`);
  }

  const closed = await client.call("session.close", { sessionId: session.sessionId });
  assert.ok(closed.closed, "session closed");
  console.log(`[smoke] session.close ok`);
}

await client.close();
await server.stop();
await new Promise((r) => fixture.close(r));
console.log("[smoke] foundation green ✓");
