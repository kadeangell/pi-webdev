/**
 * `env.*` methods — environment-level introspection. Doc 03-protocol §3.2.
 * The digest is the highest-leverage piece of token engineering in the
 * protocol; see doc 03 §3.4 for the design notes.
 */
import type { FrameworkCapability } from "../capabilities.js";

export interface EnvDigestParams {
  /** ISO timestamp. Defaults to the connection's last digest cursor. */
  since?: string;
  /** Token budget for the rendered text (rough — we count characters/4). Default 800. */
  budgetTokens?: number;
  /** If true, omit the rendered text and return only structured data. */
  rawOnly?: boolean;
}

export interface EnvDigestSummaryRow {
  domain: string;
  detail: string;
}

export interface EnvDigestResult {
  /** ISO timestamp; pass back as `since` next turn. */
  cursor: string;
  /** Wall-clock interval covered, in milliseconds. */
  intervalMs: number;
  /** Per-domain summary lines (machine-readable). */
  summary: EnvDigestSummaryRow[];
  /** Raw event list (capped by budget). */
  events: Array<{ timestamp: string; method: string; params: unknown }>;
  /** LLM-shaped rendered text. Empty when `rawOnly: true` or no events. */
  text: string;
  /** True when events were dropped to fit budget. */
  truncated: boolean;
}

export interface EnvDetectFrameworkResult {
  framework: FrameworkCapability;
}
