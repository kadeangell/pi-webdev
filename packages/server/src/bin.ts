#!/usr/bin/env node
import { createServer } from "./server.js";

function parseArgs(argv: string[]): { host?: string; port?: number; projectRoot?: string } {
  const out: { host?: string; port?: number; projectRoot?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) { out.host = next; i++; }
    else if (arg === "--port" && next) { out.port = Number(next); i++; }
    else if (arg === "--project-root" && next) { out.projectRoot = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const server = await createServer(args);

// eslint-disable-next-line no-console
console.error(`[pi-webdev-server] listening at ${server.url}`);
console.error(`[pi-webdev-server] project root: ${args.projectRoot ?? process.cwd()}`);
console.error(`[pi-webdev-server] registered methods: ${server.dispatcher.registeredMethods().join(", ")}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`[pi-webdev-server] received ${signal}, shutting down`);
    server.stop().then(() => process.exit(0));
  });
}
