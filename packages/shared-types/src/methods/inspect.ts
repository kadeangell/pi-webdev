/**
 * `inspect.*` — framework introspection, currently React-only.
 *
 * Component IDs are stable across renders: hash of
 *   path-from-root  +  componentName  +  key
 * so an LLM that asks for a component's props in turn N can ask for the
 * same component's props in turn N+1 without re-walking the tree.
 *
 * See doc 06-framework-introspection for the design notes.
 */

export interface InspectComponentTreeParams {
  sessionId: string;
}
export interface InspectComponentTreeNode {
  id: string;
  name: string;
  key?: string;
  hasState: boolean;
  hookCount: number;
  children: InspectComponentTreeNode[];
}
export interface InspectComponentTreeResult {
  /** True when no React renderer has reported a commit yet. */
  unavailable?: boolean;
  roots: InspectComponentTreeNode[];
}

export interface InspectComponentByQueryParams {
  sessionId: string;
  /** Substring or regex (when wrapped in /…/). */
  query: string;
}
export interface InspectComponentByQueryResult {
  matches: Array<{ id: string; name: string; key?: string }>;
}

export interface InspectPropsParams {
  sessionId: string;
  componentId: string;
}
export interface InspectPropsResult {
  /** JSON-shaped value-by-value props snapshot. */
  props: Record<string, unknown>;
}

export interface InspectStateParams {
  sessionId: string;
  componentId: string;
}
export interface InspectStateResult {
  /** Class-component state, or null for function components. */
  state?: Record<string, unknown> | null;
  /** Hook values, in declaration order. */
  hooks: Array<{ index: number; value: unknown }>;
}
