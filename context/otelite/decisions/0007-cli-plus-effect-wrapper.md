# CLI is the source of truth; a thin Effect-native wrapper sits on top

otelite ships the Rust CLI as the canonical interface, plus a thin typed Effect
helper (`@overeng/otelite-effect`) for the Effect/TS test harness. The CLI's
JSON output (`run` summary, `inspect` rows) is the single contract; the wrapper
shells out and decodes — it never reimplements capture/inspect.

## Why both

- The primary consumer (an Effect/TS observability test harness) wants
  typed ergonomics on day one (`Schema`-decoded summary + spans, scoped
  lifecycle), so a CLI-only v1 would push every test to hand-roll parsing.
- Keeping the CLI authoritative means the wrapper is a small adapter, not a
  second implementation — no TS↔Rust logic drift, only a JSON contract to track
  (locked by the conformance goldens).

## Effect-native, not child_process

The wrapper uses `@effect/platform` `Command` + `CommandExecutor` to spawn,
`Schema` to decode, `Effect.Service` to expose, and tagged errors on the error
channel — per `/sk-effect`. Receiver/child lifecycle is a scoped resource.

## Consequence

A second package (TS) joins the Rust crate. Accepted: it's a thin adapter over a
stable JSON contract, and the typed surface is the point for the Effect harness.
If non-Effect consumers appear, they use the CLI directly — no helper needed.
