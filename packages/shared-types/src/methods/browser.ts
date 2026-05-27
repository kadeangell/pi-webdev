/**
 * `browser.*` and browser-bound `session.*` shapes. The browser subsystem
 * speaks CDP internally (currently Lightpanda); WDP exposes a narrower,
 * LLM-shaped surface — see doc 03-protocol §3.2 and doc 04-browser.
 */

export interface SessionCreateParams {
  /** Optional initial URL to navigate to as part of creation. */
  url?: string;
}
export interface SessionCreateResult {
  sessionId: string;
}

export interface SessionListResult {
  sessions: Array<{ sessionId: string; url?: string }>;
}

export interface SessionCloseParams {
  sessionId: string;
}
export interface SessionCloseResult {
  closed: boolean;
}

export interface BrowserNavigateParams {
  sessionId: string;
  url: string;
  /** Wait for the page to reach this lifecycle event. Defaults to "load". */
  waitFor?: "navigation" | "load" | "domContentLoaded";
}
export interface BrowserNavigateResult {
  url: string;
  loaderId?: string;
  frameId?: string;
}

export interface BrowserDomParams {
  sessionId: string;
  /** "text" → innerText, "html" → outerHTML, "aria" → accessibility tree. Defaults to "text". */
  mode?: "text" | "html" | "aria";
  /** Optional selector to scope the query. Defaults to document. */
  selector?: string;
}
export interface BrowserDomResult {
  mode: "text" | "html" | "aria";
  text?: string;
  html?: string;
  tree?: unknown;
}

export interface BrowserEvalParams {
  sessionId: string;
  expression: string;
  /** Wait for promise resolution. Default true. */
  awaitPromise?: boolean;
}
export interface BrowserEvalResult {
  result?: unknown;
  exception?: { message: string };
}

export interface BrowserClickParams {
  sessionId: string;
  selector: string;
}
export interface BrowserClickResult {
  dispatched: boolean;
}

export interface BrowserFillParams {
  sessionId: string;
  selector: string;
  value: string;
}
export interface BrowserFillResult {
  dispatched: boolean;
}

export interface BrowserConsoleParams {
  sessionId: string;
  /** ISO timestamp; only entries strictly after are returned. */
  since?: string;
  /** Cap on number of entries. Default 100. */
  limit?: number;
}
export interface BrowserConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: string;
}
export interface BrowserConsoleResult {
  entries: BrowserConsoleEntry[];
}
