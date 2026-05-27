/**
 * `test.*` and `lint.*` — doc 03 §3.2. v0 backs them with Vitest + ESLint
 * via their Node APIs.
 */

export interface TestListResult {
  tests: Array<{ id: string; name: string; file: string }>;
}

export interface TestRunParams {
  /** File glob or pattern filter passed to Vitest. */
  pattern?: string;
  /** Limit run to these specific files (project-relative). */
  files?: string[];
}
export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: Array<{
    test: string;
    file: string;
    message: string;
  }>;
}

export interface LintDiagnostic {
  file: string;
  line: number;
  column: number;
  ruleId: string | null;
  severity: "off" | "warning" | "error";
  message: string;
}
export interface LintDiagnosticsParams {
  /** Files (project-relative) to lint. If omitted, lints everything tracked. */
  files?: string[];
}
export interface LintDiagnosticsResult {
  diagnostics: LintDiagnostic[];
}

export const TestLintEventMethods = {
  TestStarted: "test.started",
  TestResult: "test.result",
  TestCompleted: "test.completed",
  LintChanged: "lint.diagnostics_changed",
} as const;
