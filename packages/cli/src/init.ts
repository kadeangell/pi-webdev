/**
 * `pi-webdev init` — detect the project and write pi-webdev.config.json.
 *
 * Deliberately does NOT write AGENTS.md. Doc 02 §2.5 weighed appending to
 * the user's AGENTS.md vs. dynamic per-turn injection and settled on the
 * latter — disk writes into a file the user owns feel intrusive. Project
 * facts reach the LLM through the digest, not a generated file.
 */
import { existsSync } from "node:fs";
import { createServer } from "@pi-webdev/server";
import { CONFIG_FILENAME, configPath, writeConfig, type PiWebdevConfig } from "./config.js";

export interface InitOptions {
  projectRoot: string;
  port?: number;
  force: boolean;
  json: boolean;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const existing = configPath(opts.projectRoot);
  if (existsSync(existing) && !opts.force) {
    process.stderr.write(`${CONFIG_FILENAME} already exists. Re-run with --force to overwrite.\n`);
    return 1;
  }

  // Boot an ephemeral server purely to run capability detection, then stop it.
  const server = await createServer({ port: 0, projectRoot: opts.projectRoot });
  let caps;
  try {
    const probe = await import("@pi-webdev/coding-agent/client");
    const client = await probe.WdpClient.connect({ url: server.url, client: "pi-webdev-init" });
    const result = (await client.call("session.capabilities", {})) as { capabilities: any };
    caps = result.capabilities;
    await client.close();
  } finally {
    await server.stop();
  }

  const config: PiWebdevConfig = {
    port: opts.port ?? 48710,
    host: "127.0.0.1",
  };
  if (caps.devServer?.type === "vite") {
    config.viteProbeUrl = "http://127.0.0.1:5173/";
  }
  const written = await writeConfig(opts.projectRoot, config);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ written, config, detected: caps }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`pi-webdev initialised.\n\n`);
  process.stdout.write(`  config:     ${written}\n`);
  process.stdout.write(`  framework:  ${caps.framework.detected}${caps.framework.version ? ` ${caps.framework.version}` : ""}\n`);
  process.stdout.write(`  dev server: ${caps.devServer.type}${caps.devServer.version ? ` ${caps.devServer.version}` : ""}\n`);
  process.stdout.write(`  types:      ${caps.lsp.available.join(", ") || "none"}\n`);
  process.stdout.write(`  tests:      ${caps.test.runner}\n`);
  process.stdout.write(`  browser:    ${caps.browser.engine}${caps.browser.version ? ` ${caps.browser.version}` : ""}\n`);
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  pi-webdev daemon install      # run the server continuously\n`);
  process.stdout.write(`  pi-webdev serve               # or run it in the foreground\n`);
  return 0;
}
