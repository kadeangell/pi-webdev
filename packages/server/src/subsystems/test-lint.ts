/**
 * Test runner + lint subsystems.
 *
 * Vitest via its Node API (`vitest/node`'s `startVitest`), ESLint via its
 * Node API (`eslint`'s `ESLint` class). Both lazy-load so the subsystem
 * is optional — when the package isn't installed in the project root,
 * the subsystem skips registration entirely.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ErrorCodes,
  WdpError,
  type LintDiagnostic,
  type LintDiagnosticsParams,
  type LintDiagnosticsResult,
  type TestListResult,
  type TestRunParams,
  type TestRunResult,
} from "@pi-webdev/shared-types";
import type { Subsystem } from "./registry.js";
import type { Dispatcher } from "../dispatcher.js";

const localRequire = createRequire(import.meta.url);

// -------------------------------------------------------------------- vitest

export class VitestSubsystem implements Subsystem {
  readonly name = "vitest";
  readonly events = new EventEmitter();
  private resolved = false;
  private vitestModule: any = null;

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<void> {
    const projectVitest = path.join(this.projectRoot, "node_modules", "vitest");
    const path1 = existsSync(projectVitest) ? path.join(projectVitest, "dist", "node.js") : null;
    let mod: any;
    try {
      mod = path1 ? await import(path1) : await import("vitest/node");
    } catch {
      throw new Error("vitest not resolvable from project or server");
    }
    this.vitestModule = mod;
    this.resolved = true;
  }

  async stop(): Promise<void> {
    this.resolved = false;
    this.vitestModule = null;
  }

  heartbeat(): boolean {
    return this.resolved;
  }

  async list(): Promise<TestListResult> {
    if (!this.resolved) throw new WdpError(ErrorCodes.SubsystemNotReady, "vitest not ready");
    const vitest = await this.vitestModule.startVitest("test", [], { run: false, watch: false, root: this.projectRoot, reporters: [] as string[] });
    if (!vitest) return { tests: [] };
    try {
      const files: Array<{ id?: string; name?: string; filepath?: string }> = (await vitest.globTestSpecifications?.()) ?? [];
      return {
        tests: files.map((f) => ({
          id: f.id ?? f.filepath ?? "",
          name: f.name ?? path.basename(f.filepath ?? ""),
          file: f.filepath ? path.relative(this.projectRoot, f.filepath) : "",
        })),
      };
    } finally {
      await vitest.close?.();
    }
  }

  async run(params: TestRunParams = {}): Promise<TestRunResult> {
    if (!this.resolved) throw new WdpError(ErrorCodes.SubsystemNotReady, "vitest not ready");
    const startedAt = Date.now();
    this.events.emit("started", { pattern: params.pattern });
    const filters = params.files ?? (params.pattern ? [params.pattern] : []);
    const vitest = await this.vitestModule.startVitest(
      "test",
      filters,
      { run: true, watch: false, root: this.projectRoot, reporters: [] as string[] },
    );
    if (!vitest) {
      const r: TestRunResult = { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] };
      this.events.emit("completed", r);
      return r;
    }
    try {
      // Newer Vitest exposes results via `state` / `getFiles()`.
      const files: any[] = vitest.state.getFiles?.() ?? [];
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const failures: TestRunResult["failures"] = [];
      const walk = (suite: any, fileRel: string) => {
        for (const task of suite.tasks ?? []) {
          if (task.type === "test") {
            const state = task.result?.state ?? "skip";
            if (state === "pass") passed++;
            else if (state === "fail") {
              failed++;
              const err = task.result?.errors?.[0];
              failures.push({
                test: task.name,
                file: fileRel,
                message: err?.message ?? "test failed",
              });
            } else skipped++;
          } else if (task.type === "suite") {
            walk(task, fileRel);
          }
        }
      };
      for (const f of files) walk(f, path.relative(this.projectRoot, f.filepath ?? f.file ?? ""));
      const durationMs = Date.now() - startedAt;
      const result: TestRunResult = { passed, failed, skipped, durationMs, failures };
      this.events.emit("completed", result);
      return result;
    } finally {
      await vitest.close?.();
    }
  }
}

// -------------------------------------------------------------------- eslint

export class EslintSubsystem implements Subsystem {
  readonly name = "eslint";
  readonly events = new EventEmitter();
  private eslintCtor: any = null;
  private instance: any = null;

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<void> {
    // Try project-local eslint first.
    let mod: any;
    const projectEslint = path.join(this.projectRoot, "node_modules", "eslint");
    try {
      mod = existsSync(projectEslint)
        ? localRequire(projectEslint)
        : await import("eslint");
    } catch {
      throw new Error("eslint not resolvable");
    }
    this.eslintCtor = mod.ESLint ?? mod.default?.ESLint;
    if (!this.eslintCtor) throw new Error("eslint package missing ESLint class");
    this.instance = new this.eslintCtor({ cwd: this.projectRoot, errorOnUnmatchedPattern: false });
  }

  async stop(): Promise<void> {
    this.instance = null;
    this.eslintCtor = null;
  }

  heartbeat(): boolean {
    return this.instance !== null;
  }

  async diagnostics(params: LintDiagnosticsParams = {}): Promise<LintDiagnosticsResult> {
    if (!this.instance) throw new WdpError(ErrorCodes.SubsystemNotReady, "eslint not ready");
    const targets = (params.files ?? ["**/*.{js,jsx,ts,tsx,mjs,cjs}"])
      .map((p) => path.isAbsolute(p) ? p : path.join(this.projectRoot, p));
    let results: any[];
    try {
      results = await this.instance.lintFiles(targets);
    } catch (err) {
      throw new WdpError(ErrorCodes.ToolError, `eslint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const diagnostics: LintDiagnostic[] = [];
    for (const r of results) {
      for (const m of r.messages) {
        diagnostics.push({
          file: path.relative(this.projectRoot, r.filePath),
          line: m.line ?? 0,
          column: m.column ?? 0,
          ruleId: m.ruleId ?? null,
          severity: m.severity === 2 ? "error" : m.severity === 1 ? "warning" : "off",
          message: m.message ?? "",
        });
      }
    }
    this.events.emit("changed", { count: diagnostics.length });
    return { diagnostics };
  }
}

// -------------------------------------------------------------------- register

export function registerVitestSubsystem(dispatcher: Dispatcher, vitest: VitestSubsystem): void {
  dispatcher.register<unknown, TestListResult>("test.list", () => vitest.list());
  dispatcher.register<TestRunParams, TestRunResult>("test.run", (p) => vitest.run(p ?? {}));
}

export function registerEslintSubsystem(dispatcher: Dispatcher, lint: EslintSubsystem): void {
  dispatcher.register<LintDiagnosticsParams, LintDiagnosticsResult>(
    "lint.diagnostics", (p) => lint.diagnostics(p ?? {}),
  );
}
