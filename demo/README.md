# Notion Tooling Demo Pool

Repeatable, live-drivable demos of the in-house Notion developer tooling, for a
~30-min recorded showcase aimed at developer/power-user Notion users.

See the session VRS (goals, scope, driving model) in Notion:
"Demo Session VRS — Notion Tooling Showcase".

## Interface: drive the REAL CLIs

On camera you type the actual tools — `notion-md`, `notion`, `ntn`, `sqlite3` —
never a wrapper script. Each demo is a prepared **stage** you `cd` into so the
real commands are short and natural.

- **notion md → watch-mode hero.** `notion-md sync --watch .`, then edit a file
  and save; Notion updates on screen. Zero commands per beat after the watcher.
- **notion sqlite / schema → real commands, one per beat.** `notion db ...`,
  `sqlite3 ...`, `notion schema generate ...`.
- **Layout:** terminal left, Notion page in browser right, so propagation shows.

Backstage only (never on camera): each demo has `setup.sh` / `reset.sh` to
(re)create the Notion page/DB and reset the stage to clean between takes.

## Layout

```
demo/
  bin/env.sh          # backstage: resolves binaries + $DEMO_PARENT_PAGE
  CHEATSHEET.md       # master list of the real commands to type, per demo
  <primitive>/
    stage/            # cd here on camera; pre-seeded so commands are short
    setup.sh          # backstage: create Notion page/DB, seed
    reset.sh          # backstage: back to clean slate, re-runnable
    README.md         # the beat-by-beat script + narration + wow moments
```

Primitives: `md`, `sqlite`, `schema` (stretch: `react`).

## Prerequisites

- Build the CLIs once: `devenv tasks run ts:build` (from repo root).
- The real command names on PATH (`notion-md`, `notion`) — see CHEATSHEET.
- `ntn` authenticated (`ntn whoami`).
- The demo working env shared with the `ntn` "Notion CLI" integration.

## Public-repo safety

This is a **public** repo. All seed data is **synthetic**. Never commit private
workspace content, real page bodies, or tokens. Runtime state (`*.sqlite`,
`.notion-md/`, `*.conflict.roughdraft.md`, `.demo-state/`) is gitignored.
