/**
 * pi-webdev project config. `pi-webdev init` writes it; `serve` reads it.
 * Kept deliberately small — detection does most of the work, the file just
 * records overrides.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "pi-webdev.config.json";

export interface PiWebdevConfig {
  /** WDP server port. */
  port?: number;
  /** Bind host. Local-only by default. */
  host?: string;
  /** Disable the browser subsystem, or pin the lightpanda binary. */
  browser?: false | { binary?: string };
  /** Auto-probe a Vite dev server at this URL on startup. */
  viteProbeUrl?: string;
}

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_FILENAME);
}

export async function loadConfig(projectRoot: string): Promise<PiWebdevConfig | null> {
  const p = configPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as PiWebdevConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(projectRoot: string, config: PiWebdevConfig): Promise<string> {
  const p = configPath(projectRoot);
  await writeFile(p, JSON.stringify(config, null, 2) + "\n", "utf8");
  return p;
}
