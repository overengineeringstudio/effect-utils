# otelite — Vision

## Why this exists

Instrumentation tests need to assert what a program *emits* — span shape,
attributes, service boundaries, the absence of obvious secret leakage — without
standing up the full Grafana/Tempo stack. Today that verification is either
heavyweight (the production collector + Tempo + Grafana stack) or
ad-hoc (hand-rolled receivers per test suite).

otelite is the **local-file capture lane**: a tiny, self-contained tool that
stands up a real OTLP receiver, runs a command with telemetry pointed at it,
captures traces/metrics/logs to files, and hands them back for assertions — in
milliseconds, with no stack and no configuration.

## What success looks like

- A coding agent runs one composable command — `otelite run -- <cmd>` — and gets
  back a machine-readable capture it can assert against with `jq` or a typed
  Effect helper. Zero setup, zero YAML, zero services.
- **Many agents run it at once, in parallel, with no coordination** — no shared
  ports, files, or locks. Concurrent isolation is a first-class property, not an
  afterthought.
- It is trivially adoptable: a single Nix-packaged binary, idiomatic to
  `nix run` / flake consumption, small enough that pulling it into any repo's CI
  is free.
- Captures are faithful (canonical OTLP, lossless) and the tool is honest about
  what it does and does not guarantee.

## Positioning (what it is *not*)

otelite is one **Lane** among three and replaces neither of the others:

- **The Grafana/Tempo-mediated lane** — what operators can see. The right path
  for production-shaped verification.
- **the production collector** — the real pipeline (processing, fan-out,
  redaction, storage).
- **otelite** — the local-file capture lane for fast, reproducible, parallel
  test runs.

It captures and normalizes; it does not assert, does not store long-term, does
not provide dashboards, and does not promise telemetry redaction — applications
still own secret-safe instrumentation.
