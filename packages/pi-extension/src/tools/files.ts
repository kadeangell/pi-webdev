import type { WdpClient } from "../client/index.js";
import type {
  FilesListParams,
  FilesListResult,
  FilesReadParams,
  FilesReadResult,
} from "@pi-webdev/shared-types";
import type { ToolDefinition } from "./ping.js";

export function filesReadTool(wdp: WdpClient): ToolDefinition<FilesReadParams, FilesReadResult> {
  return {
    name: "wdp.filesRead",
    description: "Read a file from the project. Returns utf8 text by default (or base64 for binary). Reads are capped at 1 MiB per call; pass a `range` for larger files.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root (or absolute, if inside the root)." },
        range: { type: "array", description: "Optional [start, end) byte range." },
        encoding: { type: "string", description: "utf8 (default) or base64" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    invoke: (args) => wdp.call<FilesReadResult>("files.read", args),
  };
}

export function filesListTool(wdp: WdpClient): ToolDefinition<FilesListParams, FilesListResult> {
  return {
    name: "wdp.filesList",
    description: "List project files. Skips node_modules, dist, build, .git, .next, .turbo, .cache and dotfiles. Optional `glob` filter and `limit`.",
    schema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Subdirectory to list. Defaults to project root." },
        glob: { type: "string", description: "Glob pattern (** /, *, ?, [..])." },
        limit: { type: "number", description: "Max entries to return (default 1000, hard cap 5000)." },
      },
      additionalProperties: false,
    },
    invoke: (args) => wdp.call<FilesListResult>("files.list", args),
  };
}
