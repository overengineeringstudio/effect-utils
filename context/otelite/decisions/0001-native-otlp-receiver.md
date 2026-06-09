# Native Rust OTLP receiver, not a collector-contrib wrapper

otelite implements its own in-process OTLP receiver in Rust rather than
spawning `opentelemetry-collector-contrib`. A prototype confirmed a ~1.8MB
self-contained binary accepts real OTLP/HTTP exports, decodes via
`opentelemetry-proto`, writes canonical OTLP/JSON, injects `OTEL_*` env, runs a
child, and preserves its exit code.

## Why

- The job is a **test capture target**, not a production pipeline. The
  collector's strengths (processors, fan-out, redaction, hardening) are
  explicit non-goals — the Grafana/Tempo-mediated lane + the real system
  collector own that.
- Optimizing for "simple, elegant, coding-agent-optimized, per-test isolation":
  ms startup, no YAML, ~1.8MB beats a ~500MB Nix closure + YAML config surface.
- "If we need to write code, use Rust" — the receiver is the code worth owning.

## Considered and rejected

- **Wrap collector-contrib** (the issue's original requirement): full protocol
  coverage for free, but ~500MB closure, slower start, heavier than the job
  needs. The wrap requirement predates the simple/elegant/Rust framing.

## Consequence

We own OTLP decode and protocol coverage ourselves (scoped separately). This is
bounded: the wire formats are stable and `opentelemetry-proto` does the heavy
lifting.
