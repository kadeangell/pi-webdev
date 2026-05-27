import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ServerCapabilities } from "@pi-webdev/shared-types";

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readJson(filePath: string): Promise<PackageJsonShape | null> {
  try {
    const buf = await readFile(filePath, "utf8");
    return JSON.parse(buf) as PackageJsonShape;
  } catch {
    return null;
  }
}

function pickVersion(pkg: PackageJsonShape | null, name: string): string | undefined {
  if (!pkg) return undefined;
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
}

/**
 * Best-effort static capability detection from the project root.
 *
 * This intentionally does NOT spawn subsystems — it only inspects
 * package.json and notable files. Real subsystem readiness gets reported
 * dynamically via $/subsystem.status events. See doc 03-protocol §3.5.
 */
export async function detectCapabilities(projectRoot: string, methods: string[]): Promise<ServerCapabilities> {
  const pkg = await readJson(path.join(projectRoot, "package.json"));

  // Framework detection: react first, then vue/svelte/solid.
  const reactV = pickVersion(pkg, "react");
  const vueV = pickVersion(pkg, "vue");
  const svelteV = pickVersion(pkg, "svelte");
  const solidV = pickVersion(pkg, "solid-js");
  const framework: ServerCapabilities["framework"] = reactV
    ? { detected: "react", version: reactV, introspection: "react-devtools-backend" }
    : vueV
      ? { detected: "vue", version: vueV, introspection: "none" }
      : svelteV
        ? { detected: "svelte", version: svelteV, introspection: "none" }
        : solidV
          ? { detected: "solid", version: solidV, introspection: "none" }
          : pkg
            ? { detected: "unknown", introspection: "none" }
            : { detected: "none", introspection: "none" };

  // Dev server: vite > next > webpack.
  const viteV = pickVersion(pkg, "vite");
  const nextV = pickVersion(pkg, "next");
  const webpackV = pickVersion(pkg, "webpack");
  const devServer: ServerCapabilities["devServer"] = viteV
    ? { type: "vite", version: viteV, hmr: true }
    : nextV
      ? { type: "next", version: nextV, hmr: true }
      : webpackV
        ? { type: "webpack", version: webpackV, hmr: true }
        : pkg
          ? { type: "unknown", hmr: false }
          : { type: "none", hmr: false };

  // LSP / TypeScript detection.
  const tsV = pickVersion(pkg, "typescript");
  const hasTsconfig = existsSync(path.join(projectRoot, "tsconfig.json"));
  const lsp: ServerCapabilities["lsp"] = {
    available: tsV || hasTsconfig ? ["typescript"] : [],
    not_detected: ["eslint"],
    ...(tsV ? { typescript: { version: tsV } } : {}),
  };

  // Test runner.
  const vitestV = pickVersion(pkg, "vitest");
  const jestV = pickVersion(pkg, "jest");
  const playwrightV = pickVersion(pkg, "@playwright/test") ?? pickVersion(pkg, "playwright");
  const test: ServerCapabilities["test"] = vitestV
    ? { runner: "vitest", version: vitestV }
    : jestV
      ? { runner: "jest", version: jestV }
      : playwrightV
        ? { runner: "playwright", version: playwrightV }
        : { runner: "none" };

  // Browser: nothing wired up yet; the foundation has no live subsystem.
  // The dispatcher's method list is the source of truth for what's actually callable.
  const browser: ServerCapabilities["browser"] = {
    engine: "none",
    features: [],
    limitations: ["browser-subsystem-not-implemented"],
  };

  return {
    methods,
    browser,
    lsp,
    devServer,
    framework,
    test,
    projectRoot,
  };
}
