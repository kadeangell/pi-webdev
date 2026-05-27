import { createServer } from "@pi-webdev/server";
import { WdpClient } from "@pi-webdev/coding-agent/client";

interface CliFlags {
  url?: string;
  auto: boolean;
  projectRoot: string;
  json: boolean;
  echo?: string;
  limit?: number;
  session?: string;
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
  browser open URL                Create a session and navigate to URL. Prints sessionId.
  browser dom [--session ID]      Print innerText of the document.
  browser eval EXPR               Evaluate EXPR in the current session.
  browser click SELECTOR          Click an element.
  browser fill SELECTOR VALUE     Fill an input.
  browser console                 Dump captured console entries for the session.
  browser close                   Close the current session.
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
    else if (arg === "--session" && next) { flags.session = next; i++; }
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

      case "browser": {
        const sub = args.positional[0];
        const sessionIdArg = args.session;

        const open = async (url: string): Promise<string> => {
          const r = (await client.call("session.create", url ? { url } : {})) as { sessionId: string };
          return r.sessionId;
        };

        if (sub === "open") {
          const url = args.positional[1];
          if (!url) throw new Error("browser open requires URL");
          const id = await open(url);
          if (args.json) print("", { sessionId: id, url });
          else process.stdout.write(`${id}\n`);
        } else if (sub === "dom") {
          const url = args.positional[1];
          const id = sessionIdArg ?? (url ? await open(url) : null);
          if (!id) throw new Error("browser dom requires URL or --session");
          const r = (await client.call("browser.dom", { sessionId: id, mode: "text" })) as { text: string };
          if (args.json) print("", r);
          else process.stdout.write(`${r.text}\n`);
          if (!sessionIdArg) await client.call("session.close", { sessionId: id });
        } else if (sub === "eval") {
          // forms:  browser eval URL EXPR  (one-shot)  |  browser eval --session ID EXPR
          const a = args.positional[1];
          const b = args.positional[2];
          const oneShot = !sessionIdArg && b !== undefined;
          const id = sessionIdArg ?? (oneShot ? await open(a!) : null);
          const expr = oneShot ? b! : a;
          if (!id || !expr) throw new Error("browser eval requires URL EXPR or --session EXPR");
          const r = (await client.call("browser.eval", { sessionId: id, expression: expr })) as { result?: unknown; exception?: { message: string } };
          if (args.json) print("", r);
          else if (r.exception) process.stdout.write(`exception: ${r.exception.message}\n`);
          else process.stdout.write(`${typeof r.result === "string" ? r.result : JSON.stringify(r.result)}\n`);
          if (!sessionIdArg) await client.call("session.close", { sessionId: id });
        } else if (sub === "click") {
          if (!sessionIdArg) throw new Error("browser click requires --session ID (use against a daemon)");
          const selector = args.positional[1];
          if (!selector) throw new Error("browser click requires SELECTOR");
          await client.call("browser.click", { sessionId: sessionIdArg, selector });
        } else if (sub === "fill") {
          if (!sessionIdArg) throw new Error("browser fill requires --session ID");
          const selector = args.positional[1];
          const value = args.positional[2];
          if (!selector || value === undefined) throw new Error("browser fill requires SELECTOR VALUE");
          await client.call("browser.fill", { sessionId: sessionIdArg, selector, value });
        } else if (sub === "console") {
          if (!sessionIdArg) throw new Error("browser console requires --session ID");
          const r = (await client.call("browser.console", { sessionId: sessionIdArg })) as { entries: Array<{ level: string; text: string }> };
          if (args.json) print("", r);
          else for (const e of r.entries) process.stdout.write(`[${e.level}] ${e.text}\n`);
        } else if (sub === "close") {
          if (!sessionIdArg) throw new Error("browser close requires --session ID");
          const r = await client.call("session.close", { sessionId: sessionIdArg });
          if (args.json) print("", r);
        } else {
          throw new Error(`unknown browser subcommand: ${sub ?? "(none)"}`);
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
