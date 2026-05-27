/**
 * `files.*` method shapes. Mirrors doc 03-protocol §3.2 but trimmed
 * to what the foundation can serve in-process (read-only).
 */

export interface FilesReadParams {
  path: string;
  /** Optional byte range [start, end). Omit to read the whole file. */
  range?: [number, number];
  /** Defaults to "utf8". "base64" returned for binary. */
  encoding?: "utf8" | "base64";
}
export interface FilesReadResult {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  byteLength: number;
  /** True when the requested range was clamped to file size. */
  truncated: boolean;
}

export interface FilesListParams {
  /** Subdirectory of project root. Defaults to project root. */
  dir?: string;
  /** Glob pattern relative to dir (very small subset: ** /, *, ?, [..]). */
  glob?: string;
  /** Cap on number of entries returned. */
  limit?: number;
}
export interface FilesListResult {
  paths: string[];
  /** True when the listing was truncated by the limit. */
  truncated: boolean;
}

export interface FilesWriteParams {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  /** Create parent directories if missing. Defaults to false. */
  createDirs?: boolean;
}
export interface FilesWriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface FilesChangedSinceParams {
  /** ISO timestamp. Returns events with `timestamp > since`. */
  since: string;
  /** Optional path-prefix filter. */
  pathPrefix?: string;
  /** Cap on number of entries. Default 200. */
  limit?: number;
}
export interface FilesChangeEntry {
  path: string;
  kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  timestamp: string;
}
export interface FilesChangedSinceResult {
  changes: FilesChangeEntry[];
  /** Server-emitted sequence cursor — pass back as `since` next time. */
  cursor: string;
  truncated: boolean;
}

export interface FilesDepGraphParams {
  /** Entry file (project-relative). */
  entry: string;
}
export interface FilesDepGraphNode {
  id: string;
  bytes?: number;
}
export interface FilesDepGraphEdge {
  from: string;
  to: string;
  kind?: "import" | "require" | "dynamic";
}
export interface FilesDepGraphResult {
  entry: string;
  graph: {
    nodes: FilesDepGraphNode[];
    edges: FilesDepGraphEdge[];
  };
  warnings?: string[];
}
