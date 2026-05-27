/**
 * In-page React inspector. Injected via Runtime.evaluate before React
 * loads (or as early as we can) so that:
 *
 *   1. We pre-install `__REACT_DEVTOOLS_GLOBAL_HOOK__` — React's DOM
 *      reconciler looks for it at module-init time and calls
 *      `hook.inject(renderer)` when it boots. That gives us the
 *      renderer object.
 *
 *   2. We hook `hook.onCommitFiberRoot(rendererId, root)` to capture
 *      every commit's root fiber.
 *
 *   3. We expose `window.__piWebdev` with `tree()`, `props(id)`, and
 *      `state(id)` — small enough for the LLM-side methods to be
 *      single Runtime.evaluate calls.
 *
 * Component IDs are stable: hash of
 *   path-from-root  +  componentName  +  key
 * which means asking for the same component again next turn lands on
 * the same id, even if siblings have moved.
 */

export const INSPECT_INJECTION_SCRIPT = `(function () {
  if (window.__piWebdev) return "already-installed";
  var roots = new Map();
  var rendererIds = 0;

  function ensureHook() {
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var hook = {
      supportsFiber: true,
      renderers: new Map(),
      _piRoots: roots,
      inject: function (renderer) {
        var id = ++rendererIds;
        this.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot: function (rendererId, root) {
        roots.set(rendererId, root);
      },
      onCommitFiberUnmount: function () {},
      onPostCommitFiberRoot: function () {},
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: hook, configurable: false, writable: false,
    });
    return hook;
  }
  ensureHook();

  function hash(input) {
    // Small djb2 hash → hex; stable enough as a component id.
    var h = 5381;
    for (var i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function fiberName(fiber) {
    var type = fiber.type;
    if (type == null) return null;
    if (typeof type === "string") return null; // host components — skip
    return type.displayName || type.name || "Anonymous";
  }

  function isComponent(fiber) {
    return typeof fiber.type === "function" || (fiber.type && typeof fiber.type === "object");
  }

  function safeJson(value, depth) {
    depth = depth || 0;
    if (depth > 4) return "[depth]";
    if (value === null) return null;
    var t = typeof value;
    if (t === "function") return "[fn " + (value.name || "anon") + "]";
    if (t === "undefined") return undefined;
    if (t === "symbol") return value.toString();
    if (t !== "object") return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(function (v) { return safeJson(v, depth + 1); });
    if (value && value.$$typeof) return "[react element]";
    var out = {};
    var keys = Object.keys(value).slice(0, 30);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = safeJson(value[keys[i]], depth + 1);
    return out;
  }

  function buildNode(fiber, pathPrefix) {
    var name = fiberName(fiber);
    var key = fiber.key != null ? String(fiber.key) : "";
    var path = pathPrefix + "/" + name + (key ? "[" + key + "]" : "");
    var id = hash(path);
    var node = {
      id: id,
      name: name,
      key: key || undefined,
      hasState: !!fiber.memoizedState && fiber.stateNode && typeof fiber.stateNode === "object" && "state" in fiber.stateNode,
      hookCount: countHooks(fiber),
      children: [],
      _fiber: fiber,
      _path: path,
    };
    return node;
  }

  function countHooks(fiber) {
    if (typeof fiber.type !== "function") return 0;
    // Class components have memoizedState as the state object, not a hook list.
    if (fiber.stateNode && fiber.stateNode.isReactComponent) return 0;
    var head = fiber.memoizedState;
    var n = 0;
    while (head && n < 64) { n++; head = head.next; }
    return n;
  }

  function walk(fiber, pathPrefix, out, idx) {
    if (!fiber) return;
    if (isComponent(fiber)) {
      var name = fiberName(fiber);
      if (name) {
        var node = buildNode(fiber, pathPrefix);
        idx.set(node.id, node);
        var childOut = node.children;
        var nextPrefix = node._path;
        var c = fiber.child;
        while (c) { walk(c, nextPrefix, childOut, idx); c = c.sibling; }
        out.push(node);
        return;
      }
    }
    // Host or unnamed — descend without adding a node.
    var c2 = fiber.child;
    while (c2) { walk(c2, pathPrefix, out, idx); c2 = c2.sibling; }
  }

  function buildTreeIndex() {
    var idx = new Map();
    var roots_out = [];
    roots.forEach(function (rootContainer) {
      var rootFiber = rootContainer && rootContainer.current;
      if (!rootFiber) return;
      var c = rootFiber.child;
      while (c) { walk(c, "", roots_out, idx); c = c.sibling; }
    });
    return { roots: roots_out, idx: idx };
  }

  function strip(node) {
    var out = { id: node.id, name: node.name, hasState: node.hasState, hookCount: node.hookCount, children: node.children.map(strip) };
    if (node.key) out.key = node.key;
    return out;
  }

  window.__piWebdev = {
    tree: function () {
      if (roots.size === 0) return { unavailable: true, roots: [] };
      var built = buildTreeIndex();
      return { roots: built.roots.map(strip) };
    },
    props: function (id) {
      var built = buildTreeIndex();
      var node = built.idx.get(id);
      if (!node) return { error: "not-found" };
      var props = node._fiber.memoizedProps || {};
      return { props: safeJson(props) };
    },
    state: function (id) {
      var built = buildTreeIndex();
      var node = built.idx.get(id);
      if (!node) return { error: "not-found" };
      var fiber = node._fiber;
      var hooks = [];
      var classState = null;
      if (fiber.stateNode && fiber.stateNode.isReactComponent) {
        classState = safeJson(fiber.stateNode.state || {});
      } else if (typeof fiber.type === "function") {
        var head = fiber.memoizedState;
        var i = 0;
        while (head && i < 64) {
          hooks.push({ index: i, value: safeJson(head.memoizedState) });
          head = head.next;
          i++;
        }
      }
      return { state: classState, hooks: hooks };
    },
    query: function (q) {
      var built = buildTreeIndex();
      var re;
      if (q.length > 2 && q[0] === "/" && q[q.length - 1] === "/") re = new RegExp(q.slice(1, -1));
      var matches = [];
      built.idx.forEach(function (node) {
        if (re ? re.test(node.name) : node.name.indexOf(q) >= 0) {
          matches.push({ id: node.id, name: node.name, key: node.key });
        }
      });
      return { matches: matches };
    },
  };
  return "installed";
})();`;
