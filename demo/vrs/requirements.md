# Requirements — Notion Tooling Demo

Durable requirements. Timeless (describe the system, not tasks). See `spec.md`
for how these are met.

- **R1 — Repeatable from a fresh, isolated env.** Every run starts from a clean,
  self-contained Notion environment provisioned on demand — never a single
  mutable env. Isolation makes takes repeatable and lets harness runs go
  parallel without colliding.
- **R2 — Low-effort to drive live.** On camera the presenter types the **real**
  CLIs (`notion md`, `notion db`, `notion schema`, `ntn`, `sqlite3`); no wrapper
  scripts perform the demo. A live control surface provides the exact commands
  (copy-paste) and narration.
- **R3 — Visible wow.** Each demo's payoff is on screen — live propagation, a
  SQL edit flipping a Notion cell, typed schemas, a diff-only page update — with
  the terminal and the Notion browser side by side.
- **R4 — Scripted.** Each demo has a screenplay: beats, narration ("what to
  say"), the exact commands, and what the viewer should see.
- **R5 — Proven end-to-end.** Each demo backed by a real, shipped capability is
  validated by an E2E harness that drives the real CLI and asserts the outcome via
  the Notion API, with captured evidence (terminal + Notion screenshots) usable as a
  live backup. *Caveat:* a demo previewing **planned-not-built** work (e.g. 3.2 Notion
  schema IaC — `notion schema apply` does not exist) is exempt from the harness; its
  evidence is explicitly narrated **mock** output, labelled as such (see R8).
- **R6 — Explainers are problem-first visual threads.** Each tool's explainer
  opens on the concrete problem, carries one idea per beat with a strong native
  visual (the medium looks like the real surface), and is short enough to double
  as an X thread. The **React explainer components** (`demo/dashboard/explainers/src/`,
  rendered inline in the control on the native Vite serve) are the source of truth.
- **R7 — Durable work lands in prod; the demo branch is throwaway.** Tool
  fixes/improvements discovered while building the demo go to prod PRs / issues
  on `main`; the demo material itself lives on a throwaway branch and is not
  required to merge.
- **R8 — Nothing overstated.** Explainers and narration are accurate to real
  behavior (e.g. two-way sync needs `source: shared`; Notion→local is a poll,
  not instant; schema tooling is drift-*detection*, not provisioning).
