import { createServer } from "@pi-webdev/server";
import { WdpClient } from "@pi-webdev/coding-agent/client";

interface CliFlags {
  url?: string;
  auto: boolean;
  projectRoot: string;
  json: boolean;
  echo?: string;
  limit?: number;
  positional: string[];
}

const HELP = `pi-webdev — orchestration server client + helpers

USAGE
  pi-webdev [--url URL | --auto] [--project-root DIR] [--json] <command> [args]

COMMANDS
  ping [--echo TEXT]              Round-trip a $/ping. Reports RTT.
  caps                            Print server capability snapshot.
  subsystems                      List subsystems and states.
  methods                         List all registered WDP methods.
  files list [GLOB] [--limit N]   List project files (default skip rules apply).
  files read PATH                 Read a file and print its content.
  files write PATH                Write a file. Content read from stdin.
  serve                           Run the orchestration server (no client).

FLAGS
  --url URL                       WDP endpoint. Default ws://127.0.0.1:48710/wdp.
  --auto                          Boot an ephemeral server in-process and connect.
  --project-root DIR              Project root for --auto. Default cwd.
  --json                          Print machine-readable JSON instead of formatted text.

EXAMPLES
  pi-webdev --auto ping
  pi-webdev --auto files list "**/*.ts" --limit 5
  pi-webdev --auto --json caps
`;

function parse(argv: string[]): CliFlags & { command: string } {
  const flags: CliFlags = { auto: false, projectRoot: process.cwd(), json: false, positional: [] };
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--url" && next) { flags.url = next; i++; }
    else if (arg === "--auto") { flags.auto = true; }
    else if (arg === "--project-root" && next) { flags.projectRoot = next; i++; }
    else if (arg === "--json") { flags.json = true; }
    else if (arg === "--echo" && next) { flags.echo = next; i++; }
    else if (arg === "--limit" && next) { flags.limit = Number(next); i++; }
    else if (arg === "--help" || arg === "-h") { command = "help"; }
    else if (!command) { command = arg; }
    else { flags.positional.push(arg); }
  }
  return { ...flags, command };
}

export async function run(argv: string[]): Promise<number> {
  const args = parse(argv);
  if (!args.command || args.command === "help") {
    process.stdout.write(HELP);
    return args.command === "help" ? 0 : 1;
  }

  if (args.command === "serve") {
    const server = await createServer({ projectRoot: args.projectRoot });
    process.stderr.write(`[pi-webdev] listening at ${server.url}\n`);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => server.stop().then(() => process.exit(0)));
    }
    return await new Promise(() => 0); // run forever
  }

  // Everything else needs a connected client. Spin up an in-process server if --auto.
  let server = null as Awaited<ReturnType<typeof createServer>> | null;
  let url = args.url ?? "ws://127.0.0.1:48710/wdp";
  if (args.auto) {
    server = await createServer({ port: 0, projectRoot: args.projectRoot });
    url = server.url;
  }

  const client = await WdpClient.connect({
    url,
    client: "pi-webdev-cli",
    clientVersion: "0.1.0",
  });

  const print = (label: string, value: unknown) => {
    if (args.json) {
      process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    } else {
      process.stdout.write(`${label}\n${JSON.stringify(value, null, 2)}\n`);
    }
  };

  try {
    switch (args.command) {
      case "ping": {
        const start = performance.now();
        const params = args.echo !== undefined ? { echo: args.echo } : {};
        const result = await client.call("$/ping", params);
        const rtt = (performance.now() - start).toFixed(2);
        if (args.json) {
          print("", { ...(result as object), rttMs: Number(rtt) });
        } else {
          process.stdout.write(`pong rtt=${rtt}ms ${args.echo ? `echo="${(result as { echo?: string }).echo}"` : ""}\n`);
        }
        break;
      }

      case "caps": {
        const result = (await client.call("session.capabilities", {})) as { capabilities: unknown };
        print("capabilities:", result.capabilities);
        break;
      }

      case "subsystems": {
        const result = (await client.call("session.subsystems", {})) as { subsystems: Array<{ name: string; state: string; reason?: string }> };
        if (args.json) print("", result);
        else {
          for (const s of result.subsystems) {
            process.stdout.write(`  ${s.name.padEnd(16)} ${s.state}${s.reason ? `  (${s.reason})` : ""}\n`);
          }
        }
        break;
      }

      case "methods": {
        const result = (await client.call("session.capabilities", {})) as { capabilities: { methods: string[] } };
        if (args.json) print("", { methods: result.capabilities.methods });
        else {
          for (const m of result.capabilities.methods) process.stdout.write(`  ${m}\n`);
        }
        break;
      }

      case "files": {
        const sub = args.positional[0];
        if (sub === "list") {
          const glob = args.positional[1];
          const params: { glob?: string; limit?: number } = {};
          if (glob !== undefined) params.glob = glob;
          if (args.limit !== undefined) params.limit = args.limit;
          const result = (await client.call("files.list", params)) as { paths: string[]; truncated: boolean };
          if (args.json) print("", result);
          else {
            for (const p of result.paths) process.stdout.write(`  ${p}\n`);
            if (result.truncated) process.stdout.write(`  ... (truncated)\n`);
          }
        } else if (sub === "read") {
          const filePath = args.positional[1];
          if (!filePath) throw new Error("files read requires a path");
          const result = (await client.call("files.read", { path: filePath })) as { content: string; byteLength: number; truncated: boolean };
          if (args.json) print("", result);
          else {
            process.stdout.write(result.content);
            if (!result.content.endsWith("\n")) process.stdout.write("\n");
            process.stderr.write(`[${result.byteLength} bytes${result.truncated ? ", truncated" : ""}]\n`);
          }
        } else if (sub === "write") {
          const filePath = args.positional[1];
          if (!filePath) throw new Error("files write requires a path");
          const content = await readStdin();
          const result = await client.call("files.write", { path: filePath, content });
          print("write:", result);
        } else {
          throw new Error(`unknown files subcommand: ${sub ?? "(none)"}`);
        }
        break;
      }

      default:
        process.stderr.write(`unknown command: ${args.command}\n${HELP}`);
        return 2;
    }
  } finally {
    await client.close();
    if (server) await server.stop();
  }
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
