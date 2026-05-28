# pi-webdev

An orchestration system for LLM-driven web development. Built on top of [Pi](https://pi.dev), with a custom protocol that goes beyond CDP — adding file system state, type errors, build status, HMR events, test output, and framework-level component introspection to what a coding agent can see.

The **eight-week MVP is complete**. Six subsystems (Lightpanda browser, file watcher, TypeScript LSP, Vite, Vitest, ESLint), 34 WDP methods, React component introspection, a per-turn event digest, and a `pi-webdev` CLI with `init` + daemon installer — 37 end-to-end smoke assertions, all green. See [`docs/10-status.html`](docs/10-status.html) for the full inventory and [`docs/00-progress.html`](docs/00-progress.html) for the build trail.

## Read

Open `index.html` in any browser:

```sh
open index.html              # macOS
xdg-open index.html          # Linux
```

Or serve it locally if you prefer:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Build & run

Requires Node 22+ and pnpm 10+. For the browser subsystem, install [Lightpanda](https://lightpanda.io) and put it in `PATH` (or set `LIGHTPANDA_BIN`).

```sh
pnpm install
pnpm -r run build
pnpm smoke                   # 37-assertion end-to-end test
```

Set up a project and run the server continuously:

```sh
pi-webdev init               # detect the stack, write pi-webdev.config.json
pi-webdev daemon install     # systemd (Linux) / launchd (macOS) unit
pi-webdev serve              # …or run in the foreground
```

The `pi-webdev` CLI also drives a running server, or boots an in-process one with `--auto`:

```sh
node packages/cli/dist/bin.js --auto --project-root examples/counter-app caps
node packages/cli/dist/bin.js --auto browser eval http://localhost:5173/ "document.title"
node packages/cli/dist/bin.js --auto --project-root examples/counter-app files list "**/*.tsx"
```

See [`docs/09-demo.html`](docs/09-demo.html) for captured walkthroughs and [`docs/10-status.html`](docs/10-status.html) for the full method surface. RTT on localhost: ~0.5ms per ping.

## Structure

```
pi-webdev/
├── README.md                 ← you are here
├── index.html                ← the plan overview + table of contents
├── styles.css                ← shared editorial styling
├── package.json              ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── scripts/
│   └── smoke.mjs             ← end-to-end foundation test
├── docs/
│   ├── 00-progress.html          Living log: what's built, what shifted
│   ├── 01-architecture.html      The five layers, dataflow, where state lives
│   ├── 02-pi-integration.html    Why Pi, the extension shape, install flow
│   ├── 03-protocol.html          WDP wire format, tool surface, digest design
│   ├── 04-browser.html           Lightweight browser strategy, Lightpanda
│   ├── 05-subsystems.html        File watcher, LSP, dev server, test/lint
│   ├── 06-framework-introspection.html  React DevTools backend integration
│   ├── 07-roadmap.html           Eight-week MVP, phased
│   ├── 08-risks.html             Where the plan is fragile
│   ├── 09-demo.html              Captured CLI walkthrough against the React fixture
│   └── 10-status.html            Current state: every method, subsystem, install steps, gaps
├── examples/
│   └── counter-app/          Vite + React 19 + Vitest fixture for capability detection
└── packages/
    ├── shared-types/         @pi-webdev/shared-types — WDP wire types, errors, caps
    ├── server/               @pi-webdev/server       — orchestration daemon
    ├── pi-extension/         @pi-webdev/coding-agent — Pi-side tools + WDP client
    └── cli/                  @pi-webdev/cli          — pi-webdev binary
```

## Status

**v0.1 — eight-week MVP complete.** 34 WDP methods across six subsystems (files, browser, vite, tsserver, vitest, eslint), 37 end-to-end smoke assertions. The post-0.1 plan (0.2 → 0.3 → 1.0 → beyond) is in [`docs/07-roadmap.html`](docs/07-roadmap.html#future). Honest gaps — stub Pi binding, no layout in the browser, indexed (not named) hooks — are tracked in [`docs/10-status.html`](docs/10-status.html).

## What to read first

- **10 minutes:** [Current state](docs/10-status.html) for everything that works right now, then [Architecture](docs/01-architecture.html) for the shape.
- **The build trail:** [Progress](docs/00-progress.html) logs each week and what was learned.
- **Want to start contributing:** the [future roadmap](docs/07-roadmap.html#future) §7.6 — 0.2's top item is the real Pi-extension binding.

## License

MIT — see [`LICENSE`](LICENSE). (Proposed default; matches the Pi ecosystem. Change it if another license fits better.)

## Core thesis

LLM-driven web development is bottlenecked by browser tooling designed for human QA, not autonomous agents. Playwright + headless Chrome eats 2–5 seconds per iteration; tight LLM loops need sub-100ms.

A purpose-built browser ([Lightpanda](https://lightpanda.io)) plus a richer protocol that surfaces build state, type errors, dev-server events, and framework-level introspection — wrapped behind a Pi extension — changes what an agent can do in a working session.
