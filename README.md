# pi-webdev

An orchestration system for LLM-driven web development. Built on top of [Pi](https://pi.dev), with a custom protocol that goes beyond CDP — adding file system state, type errors, build status, HMR events, test output, and framework-level component introspection to what a coding agent can see.

This repository contains **the plan plus a live foundation**. Phase 1 Week 1 of the roadmap is in — the orchestration server speaks WDP over WebSocket, the Pi extension client handshakes and round-trips. See [`docs/00-progress.html`](docs/00-progress.html) for the running changelog.

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

## Run the foundation

Requires Node 22+ and pnpm 10+.

```sh
pnpm install
pnpm -r run build
pnpm smoke                   # end-to-end round-trip test
```

Manually:

```sh
node packages/server/dist/bin.js --port 48710 --project-root .
```

The smoke test boots the server on an ephemeral port, opens a WDP client, completes `$/initialize`, calls `$/ping`, and asserts handshake / error semantics. RTT on localhost: ~0.5ms per ping.

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
│   └── 08-risks.html             Where the plan is fragile
└── packages/
    ├── shared-types/         @pi-webdev/shared-types — WDP wire types, errors, caps
    ├── server/               @pi-webdev/server       — orchestration daemon
    └── pi-extension/         @pi-webdev/coding-agent — Pi-side tools + WDP client
```

## Status

**v0.1 — foundation in, subsystems pending.** The transport, dispatcher, handshake, and capability detection are working. No real subsystems yet: the browser, file watcher, LSP, test runner, and framework introspection are still on the roadmap (Weeks 2–7).

Every section flags places of uncertainty inline with "Open question" callouts. Section 08 collects the most important ones for the spike phase.

## What to read first

- **10 minutes:** [Progress](docs/00-progress.html) for what's actually running, then [Architecture](docs/01-architecture.html) for the full shape.
- **Considering whether to commit:** [Risks and open questions](docs/08-risks.html) first.
- **Want to start contributing:** [Roadmap](docs/07-roadmap.html) §7.1 Week 2 — the browser subsystem is the next thing that needs to land.

## Core thesis

LLM-driven web development is bottlenecked by browser tooling designed for human QA, not autonomous agents. Playwright + headless Chrome eats 2–5 seconds per iteration; tight LLM loops need sub-100ms.

A purpose-built browser (probably [Lightpanda](https://lightpanda.io)) plus a richer protocol that surfaces build state, type errors, dev-server events, and framework-level introspection — wrapped behind a Pi extension — could change what an agent can do in a working session.

## License

The plan is shared as-is. License TBD once there's something to license.
