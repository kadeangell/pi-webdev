/**
 * Digest service — collects server-side events into a ring buffer and renders
 * a per-turn summary. The format is the highest-leverage piece of token
 * engineering in WDP (doc 03 §3.4); this implementation favours:
 *
 *   - Inline summary lines (machine-readable) before any prose
 *   - Status icons that read at a glance (✓ ✗ ~)
 *   - Recency-weighted ordering (newest summary first, oldest events trimmed)
 *   - A configurable token budget; characters/4 as the rough estimate
 */
import type {
  EnvDigestParams,
  EnvDigestResult,
  EnvDigestSummaryRow,
} from "@pi-webdev/shared-types";

interface RecordedEvent {
  timestamp: string;
  method: string;
  params: unknown;
}

const RING_LIMIT = 2000;

export class DigestService {
  private ring: RecordedEvent[] = [];
  /** Per-connection cursor; defaults to "all events" when never seen. */
  private cursors = new Map<string, string>();

  record(method: string, params: unknown): void {
    this.ring.push({ timestamp: new Date().toISOString(), method, params });
    if (this.ring.length > RING_LIMIT) this.ring.splice(0, this.ring.length - RING_LIMIT);
  }

  /** Render the digest for one connection, advancing its cursor. */
  render(connectionId: string, params: EnvDigestParams = {}): EnvDigestResult {
    const since = params.since ?? this.cursors.get(connectionId) ?? new Date(0).toISOString();
    const sinceMs = Date.parse(since);
    const candidates = this.ring.filter((e) => Date.parse(e.timestamp) > sinceMs);

    const budget = params.budgetTokens ?? 800;
    const charBudget = budget * 4;
    const summary = summarise(candidates);

    // Build a textual digest until we hit the char budget.
    let text = "";
    let truncated = false;
    if (!params.rawOnly && candidates.length > 0) {
      const intervalMs = Date.now() - sinceMs;
      const header = `ENVIRONMENT EVENTS since last turn (${formatInterval(intervalMs)}):\n`;
      text = header;
      for (const row of summary) {
        const line = `  ${row.detail}\n`;
        if (text.length + line.length > charBudget) {
          truncated = true;
          break;
        }
        text += line;
      }
    }

    // Cap raw events list at the budget too — favour the most recent.
    const eventsBudget = Math.max(50, Math.floor(charBudget / 80));
    const events = candidates.slice(-eventsBudget);
    if (events.length < candidates.length) truncated = true;

    const cursor = new Date().toISOString();
    this.cursors.set(connectionId, cursor);

    return {
      cursor,
      intervalMs: Math.max(0, Date.now() - sinceMs),
      summary,
      events,
      text,
      truncated,
    };
  }

  /** Forget a connection's cursor when it disconnects. */
  forget(connectionId: string): void {
    this.cursors.delete(connectionId);
  }
}

/** Reduce a flat event list to one summary row per (domain × outcome). */
function summarise(events: RecordedEvent[]): EnvDigestSummaryRow[] {
  if (events.length === 0) return [];

  const buckets = new Map<string, { count: number; latest: RecordedEvent }>();
  for (const e of events) {
    const key = e.method;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.latest = e;
    } else {
      buckets.set(key, { count: 1, latest: e });
    }
  }

  const rows: EnvDigestSummaryRow[] = [];

  // files.changed → grouped path summary.
  const fileChanged = buckets.get("files.changed");
  if (fileChanged) {
    const params = fileChanged.latest.params as { entries?: Array<{ path: string; kind: string }> } | undefined;
    const entries = params?.entries ?? [];
    const total = entries.length;
    const sample = entries.slice(0, 3).map((e) => e.path).join(", ");
    rows.push({
      domain: "files",
      detail: `files: ${total} changed${sample ? ` (${sample}${total > 3 ? ", …" : ""})` : ""}`,
    });
  }

  // build.completed / build.failed.
  const completed = buckets.get("build.completed");
  const failed = buckets.get("build.failed");
  if (failed) {
    const p = failed.latest.params as { errors?: number; durationMs?: number } | undefined;
    rows.push({
      domain: "build",
      detail: `build: ✗ failed (${p?.errors ?? "?"} errors)`,
    });
  } else if (completed) {
    const p = completed.latest.params as { durationMs?: number; warnings?: number } | undefined;
    const warnings = p?.warnings ?? 0;
    rows.push({
      domain: "build",
      detail: `build: ✓ ok${p?.durationMs ? ` (${p.durationMs}ms)` : ""}${warnings ? `, ${warnings} warnings` : ""}`,
    });
  }

  // hmr.update.
  const hmr = buckets.get("hmr.update");
  if (hmr) {
    const p = hmr.latest.params as { modules?: string[] } | undefined;
    const mods = p?.modules ?? [];
    rows.push({
      domain: "hmr",
      detail: `hmr: ${hmr.count} update(s)${mods.length ? ` (${mods.slice(0, 3).join(", ")}${mods.length > 3 ? ", …" : ""})` : ""}`,
    });
  }

  // Subsystem state changes.
  const subState = buckets.get("$/subsystem.status");
  if (subState) {
    const p = subState.latest.params as { name?: string; state?: string; reason?: string } | undefined;
    if (p?.state === "crashed" || p?.state === "stopped") {
      rows.push({
        domain: "subsystems",
        detail: `subsystem: ✗ ${p.name} ${p.state}${p.reason ? ` (${p.reason})` : ""}`,
      });
    }
  }

  // Anything we didn't bucket above — surface generically.
  const handled = new Set(["files.changed", "build.completed", "build.failed", "hmr.update", "$/subsystem.status", "$/serverReady"]);
  for (const [method, bucket] of buckets) {
    if (handled.has(method)) continue;
    rows.push({ domain: method.split(".")[0]!, detail: `${method}: ${bucket.count} event(s)` });
  }

  return rows;
}

function formatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
