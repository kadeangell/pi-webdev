/**
 * Server capability advertisement. Returned from `$/initialize` and
 * `session.capabilities`. Subsystems contribute to this shape.
 *
 * Shape is a *superset* of what doc 03-protocol §3.5 sketches — the doc
 * version is illustrative and the real fields will accrete as subsystems
 * land. Optional fields mean "not detected / not available in this server".
 */

export interface BrowserCapability {
  engine: "lightpanda" | "chromium" | "none";
  version?: string;
  features: string[];
  limitations?: string[];
}

export interface LspCapability {
  available: string[];
  not_detected?: string[];
  typescript?: { version: string };
}

export interface DevServerCapability {
  type: "vite" | "next" | "webpack" | "unknown" | "none";
  version?: string;
  hmr: boolean;
  routes_endpoint?: boolean;
}

export interface FrameworkCapability {
  detected: "react" | "vue" | "svelte" | "solid" | "none" | "unknown";
  version?: string;
  introspection?: "react-devtools-backend" | "none";
}

export interface TestCapability {
  runner: "vitest" | "jest" | "playwright" | "none" | "unknown";
  version?: string;
}

export interface ServerCapabilities {
  /** What WDP method domains the server currently dispatches. */
  methods: string[];
  browser: BrowserCapability;
  lsp: LspCapability;
  devServer: DevServerCapability;
  framework: FrameworkCapability;
  test: TestCapability;
  /** Project root the server believes it's operating on. */
  projectRoot?: string;
}
