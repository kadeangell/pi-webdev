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
