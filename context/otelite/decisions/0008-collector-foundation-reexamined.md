# Collector-as-foundation re-examined under challenge; native holds, hybrid reserved

The native-receiver decision (0001/0004) was challenged on the grounds that the
OpenTelemetry Collector is proven and lets us slot in off-the-shelf tooling. A
steelman explored the _strong_ form — core distro + minimal OCB build + the
extensibility ledger — not just full contrib. Native still wins; a future
`--collector-config` escape hatch is reserved for the genuine extensibility tail.

## Measured (x86_64-linux, this machine)

| Foundation         | Size       | Startup | Ephemeral `:0` | Port read-back         |
| ------------------ | ---------- | ------- | -------------- | ---------------------- |
| native Rust        | 5.1 MB     | ~5 ms   | yes            | clean (`local_addr()`) |
| OCB minimal (est.) | ~45–70 MiB | ~80 ms  | yes            | racy / non-portable    |
| core `otelcol`     | 123.8 MiB  | ~83 ms  | yes            | racy / non-portable    |
| contrib            | 321.7 MiB  | ~100 ms | yes            | racy / non-portable    |

## Findings that matter

- **Ephemeral `:0` works on the collector** (earlier "no" was wrong) — **but** it
  never reports the resolved port (logs literal `:0`); read-back needs `ss`/proc
  introspection that is racy and absent on macOS. Native reads the port cleanly.
  For a coordination-free parallel tool this is a permanent ergonomic loss.
- **File-exporter output is byte-identical to native capture** → `inspect` is
  foundation-agnostic, and a future switch is de-risked.
- **`fileexporter` is a _contrib_ component**, not core, so even a minimal OCB
  build pulls contrib. Version coupling is multi-axis and already failing in-env
  (runtime 0.124 ≠ nixpkgs 0.144 ≠ component tags 0.154).

## Extensibility ledger (the real pro-collector case)

Only two items genuinely justify the collector: **redaction/transform** of
sensitive attributes and **non-OTLP receivers** (zipkin/prometheus). Redaction
is an _explicit non-goal_ of the issue. Tail-sampling / filter / fan-out / batch
are anti-goals or cheap post-hoc on the NDJSON.

## Verdict

Keep native as the foundation. Strongest FOR collector: a proven impl with a
redaction + non-OTLP tail native can't cheaply match, whose file output already
matches ours. Strongest AGAINST: it swaps the cheap part (receiver) for a
heavier one while making the costly wrapper (port read-back, version pinning,
YAML) worse — ~10× startup, ~24–60× size — for a tail most users never touch.

## Reserved: hybrid escape hatch

A later optional `--collector-config <file>` mode can delegate to a real
collector for the redaction / non-OTLP cases. Cheap to add because otelite
already owns the wrapper; out of v1 scope (double surface) until a real user
needs it.
