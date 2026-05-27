# pi-webdev

A working draft of an orchestration system for LLM-driven web development. Built on top of [Pi](https://pi.dev), with a custom protocol that goes beyond CDP — adding file system state, type errors, build status, HMR events, test output, and framework-level component introspection to what a coding agent can see.

This repository currently contains **the plan**, not the implementation. The plan is an honest working draft with deliberately-flagged open questions throughout.

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

## Structure

```
pi-webdev/
├── README.md                 ← you are here
├── index.html                ← the plan overview + table of contents
├── styles.css                ← shared editorial styling
└── docs/
    ├── 01-architecture.html       The five layers, dataflow, where state lives
    ├── 02-pi-integration.html     Why Pi, the extension shape, install flow
    ├── 03-protocol.html           WDP wire format, tool surface, digest design
    ├── 04-browser.html            Lightweight browser strategy, Lightpanda
    ├── 05-subsystems.html         File watcher, LSP, dev server, test/lint
    ├── 06-framework-introspection.html   React DevTools backend integration
    ├── 07-roadmap.html            Eight-week MVP, phased
    └── 08-risks.html              Where the plan is fragile
```

## Status

**v0.1 — working draft.** Nothing here is implemented yet. The plan is a starting point for engineering work, not a specification.

Every section flags places of uncertainty inline with "Open question" callouts. Section 08 collects the most important ones for the spike phase.

## What to read first

- **10 minutes:** [Architecture](docs/01-architecture.html) and [Roadmap](docs/07-roadmap.html). Full shape plus the first eight weeks of work.
- **Considering whether to commit:** [Risks and open questions](docs/08-risks.html) first.
- **Want to start this week:** Phase 0 of the [Roadmap](docs/07-roadmap.html). The fastest first artifact is a 200-line Pi extension exposing three browser tools against your latest React project.

## Core thesis

LLM-driven web development is bottlenecked by browser tooling designed for human QA, not autonomous agents. Playwright + headless Chrome eats 2–5 seconds per iteration; tight LLM loops need sub-100ms.

A purpose-built browser (probably [Lightpanda](https://lightpanda.io)) plus a richer protocol that surfaces build state, type errors, dev-server events, and framework-level introspection — wrapped behind a Pi extension — could change what an agent can do in a working session.

## License

The plan is shared as-is. License TBD once there's something to license.
