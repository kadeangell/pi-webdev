/**
 * `pi-webdev daemon install|uninstall|status` — keep the orchestration
 * server running across sessions. Doc 02 §2.6 calls for a LaunchAgent on
 * macOS and a systemd user unit on Linux.
 *
 * We generate and write the unit file, then print the activation command
 * rather than running it. Activating a user service touches the user's
 * session manager — that's a side effect the operator should trigger
 * explicitly, and it lets this work in environments (containers, CI) where
 * no service manager is running.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DaemonOptions {
  projectRoot: string;
  port: number;
  /** Absolute path to the pi-webdev binary (or the serve entrypoint). */
  binPath: string;
  json: boolean;
}

interface UnitTarget {
  platform: "linux" | "darwin" | "other";
  unitPath: string;
  label: string;
}

function unitTarget(): UnitTarget {
  const home = os.homedir();
  if (process.platform === "linux") {
    return {
      platform: "linux",
      unitPath: path.join(home, ".config", "systemd", "user", "pi-webdev.service"),
      label: "pi-webdev.service",
    };
  }
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      unitPath: path.join(home, "Library", "LaunchAgents", "dev.pi-webdev.plist"),
      label: "dev.pi-webdev",
    };
  }
  return { platform: "other", unitPath: "", label: "pi-webdev" };
}

function systemdUnit(opts: DaemonOptions): string {
  return `[Unit]
Description=pi-webdev orchestration server
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${opts.binPath} serve --port ${opts.port} --project-root ${opts.projectRoot}
Restart=on-failure
RestartSec=2
WorkingDirectory=${opts.projectRoot}

[Install]
WantedBy=default.target
`;
}

function launchdPlist(opts: DaemonOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.pi-webdev</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${opts.binPath}</string>
    <string>serve</string>
    <string>--port</string><string>${opts.port}</string>
    <string>--project-root</string><string>${opts.projectRoot}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${opts.projectRoot}</string>
</dict>
</plist>
`;
}

export async function daemonInstall(opts: DaemonOptions): Promise<number> {
  const target = unitTarget();
  if (target.platform === "other") {
    process.stderr.write(`daemon install is supported on linux (systemd) and macOS (launchd); platform ${process.platform} is not supported.\n`);
    process.stderr.write(`Run the server manually instead:\n  pi-webdev serve --port ${opts.port}\n`);
    return 1;
  }
  await mkdir(path.dirname(target.unitPath), { recursive: true });
  const contents = target.platform === "linux" ? systemdUnit(opts) : launchdPlist(opts);
  await writeFile(target.unitPath, contents, "utf8");

  const activate = target.platform === "linux"
    ? `systemctl --user daemon-reload && systemctl --user enable --now pi-webdev`
    : `launchctl load -w ${target.unitPath}`;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ unitPath: target.unitPath, activate }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Wrote ${target.platform === "linux" ? "systemd unit" : "launchd plist"}:\n  ${target.unitPath}\n\n`);
  process.stdout.write(`Activate it:\n  ${activate}\n`);
  return 0;
}

export async function daemonUninstall(opts: DaemonOptions): Promise<number> {
  const target = unitTarget();
  if (target.platform === "other" || !existsSync(target.unitPath)) {
    process.stdout.write(`No daemon unit found at ${target.unitPath || "(unsupported platform)"}.\n`);
    return 0;
  }
  const deactivate = target.platform === "linux"
    ? `systemctl --user disable --now pi-webdev`
    : `launchctl unload ${target.unitPath}`;
  await rm(target.unitPath, { force: true });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ removed: target.unitPath, deactivate }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Removed ${target.unitPath}.\nIf it was active, stop it with:\n  ${deactivate}\n`);
  return 0;
}

export async function daemonStatus(opts: DaemonOptions): Promise<number> {
  const target = unitTarget();
  const installed = target.platform !== "other" && existsSync(target.unitPath);
  let unit: string | undefined;
  if (installed) unit = await readFile(target.unitPath, "utf8").catch(() => undefined);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ platform: target.platform, installed, unitPath: target.unitPath }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`platform:  ${target.platform}\n`);
  process.stdout.write(`installed: ${installed ? "yes" : "no"}\n`);
  if (target.unitPath) process.stdout.write(`unit path: ${target.unitPath}\n`);
  if (unit) process.stdout.write(`\n--- unit ---\n${unit}`);
  return 0;
}
