/**
 * `types.*` — TypeScript LSP surface, doc 03 §3.2.
 *
 * Backed by tsserver as a subprocess. v0 ships diagnostics + a small set
 * of definition-like queries; the LSP-shaped richness (rename, code
 * actions) stays out until there's user demand.
 */

export interface TypeDiagnostic {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  text: string;
  category: "error" | "warning" | "suggestion" | "message";
  code: number;
  source?: "syntax" | "semantic" | "suggestion";
}

export interface TypesDiagnosticsParams {
  /** Project-relative file paths to inspect. If omitted, returns all currently-known. */
  files?: string[];
  /** Filter by category. */
  scope?: "error" | "warning" | "suggestion" | "all";
}
export interface TypesDiagnosticsResult {
  diagnostics: TypeDiagnostic[];
}

export interface TypesHoverInfoParams {
  file: string;
  line: number;
  offset: number;
}
export interface TypesHoverInfoResult {
  contents: string;
  documentation?: string;
  range?: {
    start: { line: number; offset: number };
    end: { line: number; offset: number };
  };
}

export interface TypesDefinitionParams {
  file: string;
  line: number;
  offset: number;
}
export interface TypesDefinitionResult {
  locations: Array<{
    file: string;
    start: { line: number; offset: number };
    end: { line: number; offset: number };
  }>;
}

export interface TypesReferencesParams {
  file: string;
  line: number;
  offset: number;
}
export interface TypesReferencesResult {
  locations: Array<{
    file: string;
    start: { line: number; offset: number };
    end: { line: number; offset: number };
  }>;
}

export const TypesEventMethods = {
  DiagnosticsChanged: "types.diagnostics_changed",
} as const;
