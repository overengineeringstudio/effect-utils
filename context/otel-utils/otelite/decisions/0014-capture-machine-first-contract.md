# Machine-first `capture` contract: endpoints event + stdin-EOF stop

`otelite capture`'s stdout is a tagged NDJSON event stream — an
`otelite.endpoints/v1` line emitted the instant both listeners bind
(`http`/`grpc`/`out`), then `otelite.summary/v1` as the final line — and the
receiver stops on SIGINT/SIGTERM **or** stdin EOF. This lets a _parent_ process
(the in-process emitter case, where otelite does not own the emitter's env)
learn the ephemeral endpoint with zero string scraping and control the receiver
by closing a pipe, while ephemeral-port parallelism (R04) is preserved.

## Why

In-process capture (test harnesses asserting on telemetry the test process
itself emits) splits the emitter (the test process) from the receiver (otelite).
The receiver binds `:0` for coordination-free parallelism, so the parent must
(1) discover a dynamic address and (2) own start/stop/drain. That orchestration
is irreducibly client-side; the principled fix is to make `capture` a
first-class _programmatic_ citizen so the client glue is structured data, not a
stderr regex. The whole point of the CLI is to be machine-optimized — so embrace
a strict, self-describing, cross-language contract rather than human-shaped text.

## Considered options

- **Endpoints as a tagged stdout event (chosen).** One channel the consumer
  already reads; race-free (emitted post-bind, before serving); cross-language
  (NDJSON + a `schema` discriminator — trivial from Node/Python/Go/shell+jq);
  mirrors the cargo `--message-format=json` / LSP / Bazel `BuildFinished`
  terminal-event discipline.
- **Side file (`--endpoints-file` / `--port-file`).** Rejected as the default: a
  _second_ discovery mechanism (the summary still lands on stdout), plus
  existence-vs-completeness polling / TOCTOU. Kept as a possible future
  escape-hatch for when stdout must be reserved for raw passthrough.
- **fd / `sd_notify` readiness.** The cleanest Unix barrier, but extra parent-side
  pipe plumbing and a poor Windows story; not worth it for the common case.
- **Control-RPC (esbuild / LSP framing).** Rejected: every consumer needs a
  framing codec before it can parse — over-engineered for announce + stop + stream.
- **stdin command channel (`{"cmd":"stop"}` / `{"cmd":"flush"}`).** Rejected for
  v1: stop is already covered (signals + EOF), and the sink is write-before-ack
  (a span is on disk once its export 200s), so an otelite-side `flush` is
  meaningless — flush-determinism is the _emitter's_ job (force-flush its tracer).

## Consequences

- `capture`'s stdout contract changes from "one summary line" to "endpoints
  line … summary line"; consumers dispatch by `schema`. `run`'s one-line
  contract and `run | inspect -` are deliberately untouched (the event stream is
  `capture`-only).
- Qualifies A03: discovery is unneeded for `run` (otelite owns the child env) but
  real for in-process `capture`; the endpoints event resolves it without fixing
  ports, so R04 holds.
- stdin-EOF stop required a non-blocking `AsyncFd` over fd 0. A naive
  `tokio::io::stdin()` in the `select!` parks a blocking OS thread that prevents
  `Runtime` shutdown — hanging even SIGTERM whenever stdin is an open pipe
  (exactly the in-process case). Found and fixed during the prototype eval; this
  is the reason a "looks like a one-liner" had to be prototyped, not assumed.
- `--print-schema` lists `otelite.endpoints/v1`; the event shape is golden-locked
  like every other `otelite.*/v1` output.

## Status

Accepted; contract implemented (minimal V2). The `--endpoints-file` / `--ready-fd`
escape-hatches and any stdin command channel are explicitly deferred until a
consumer needs stdout reserved.
