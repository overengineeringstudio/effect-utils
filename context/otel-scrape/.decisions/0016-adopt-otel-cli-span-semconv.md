# 0016 - Adopt the OTel span.cli semantic conventions for the public contract

Status: accepted

Aligns the public telemetry contract to OpenTelemetry semantic conventions,
pinned to `open-telemetry/semantic-conventions` **v1.37.0** (the version PR #881
pins). Builds on the command-identity model of
[0014](./0014-command-identity-and-span-naming.md) and the trust gate of
[0015](./0015-trust-assertion-is-per-named-sink.md). Owned by [../](../).

## Context

`otel-scrape`'s whole job is process execution, but the emitted spans invented
private attribute keys (`command.program`, `command.argv`, `command.cwd`,
`process.exit_code`) where OTel already publishes a stable process registry and a
dedicated CLI-execution span convention. A SOTA review (issue #866) graded this
the single biggest "not SOTA" signal: a process wrapper that does not speak the
process semconv. The gaps are cheap and mechanical — non-standard keys, a lossy
newline-joined argv string, and an underscore where the standard uses a dot.

Two constraints govern the alignment. First, `otel-scrape` is a public substrate:
adopting upstream keys must not relax the privacy model — the trust gate (0015),
the never-default-emit rule, and high cardinality must **travel with** the
renamed keys, not be dropped in the name of "standard fields". Second, the JSON
registry SSOT should pre-align to PR #881's Weaver AttrDef field shape so a future
TS-DSL projection is mechanical, without adopting any of #881's machinery.

Evidence: the SOTA OTel trace critique (issue #866) and the #881 forward-compat
alignment (PR #881, Weaver semantic-conventions VRS), pinned to semconv v1.37.0.

## Evidence and Argument

- **The CLI-execution span convention fits, and we adopt it partially now.** OTel
  v1.37.0 defines `span.cli.internal` (model/cli/spans.yaml): span_kind INTERNAL,
  span name SHOULD be `{process.executable.name}`, status SHOULD be Error if
  `process.exit.code` != 0. `otel-scrape`'s existing basename span name +
  INTERNAL kind (0014) + status-on-nonzero already align, and the attribute
  key/type renaming lands here — so span structure and the renamed keys conform
  now. But conformance is **partial, not complete**: `span.cli.internal` extends
  `attributes.cli.common`, which lists `process.pid` (int) as **REQUIRED** and
  `error.type` as conditionally-required; `otel-scrape` emits neither today (it
  carries only a vendor `otel_scrape.command.argv_hash`, no `process.pid`). These
  two gaps are deferred to M25.1 (see Consequences), so this decision is a rename
  plus an honest declaration of what still does not conform, not a claim of full
  `span.cli` conformance.
- **Verified upstream keys and types (v1.37.0, fetched, not reconstructed):**
  `process.exit.code` (int); `process.command_args` (**string[]** — the brief
  says it SHOULD NOT be collected by default unless sanitized); `process.command_line`
  (string, discouraged when assembled only for monitoring); `process.executable.name`
  (string, base name of `/proc/[pid]/exe`, the span-name source);
  `process.working_directory` (string). All `process.*` attributes are stability
  `development`.
- **The array retype fixes a real lossiness.** The pre-semconv `command.argv` was a
  newline-joined single string, so an argument containing a newline was ambiguous.
  `process.command_args` is a string array (one element per argument) and is
  lossless. The always-present correlation hash (`otel_scrape.command.argv_hash`,
  a length-prefixed SHA-256 over the argv vector) is unchanged: only the
  trust-gated raw _display_ value changes shape.
- **Privacy must travel with the rename.** Renaming `command.argv` →
  `process.command_args` and `command.cwd` → `process.working_directory` is
  key-and-type only. The trust gate (`--trusted-sink`), never-default-emit,
  `cardinality: high`, and the redaction policy (`encode: drop`) stay attached.
  Raw argv/cwd emit only under the asserted sink, exactly as before 0016. This is
  a deliberate, documented deviation from the upstream brief's "SHOULD NOT be
  collected by default unless sanitized" guidance on `process.command_args`:
  0015's per-named-sink trust assertion substitutes for upstream sanitization —
  rather than sanitizing the value, `otel-scrape` withholds it entirely except
  into a sink the operator asserted private by name.
- **Vendor concepts stay namespaced.** The correlation hashes and the span-origin
  marker have no upstream equivalent, so they move under the `otel_scrape.*`
  vendor namespace (`otel_scrape.command.argv_hash`, `otel_scrape.command.cwd_hash`,
  `otel_scrape.span.origin`) rather than squatting on unprefixed keys.
- **The evolution trail is preserved.** Every renamed key is retained in the
  registry as a deprecated entry carrying `deprecated: {reason: "renamed",
renamed_to: <new>}`, following OTel semconv practice, rather than being
  hard-deleted. Deprecated entries are never emitted.

## Options

| Option                                                                          | Consequence                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the invented `command.*` keys (status quo)                                 | Stable, but a process wrapper that ignores the process semconv; the biggest "not SOTA" signal, and argv stays a lossy newline-joined string.   |
| Adopt upstream keys but make raw argv/cwd always-on standard fields             | Maximally "standard", but silently converts a public-substrate footgun into the default — leaks argv/paths to any shared sink. Rejected.       |
| **Adopt upstream keys + types; privacy travels with the rename (chosen)**       | Speaks the process semconv and fixes the array lossiness, while the 0015 trust gate stays bound to the renamed raw keys. Contract-only change. |
| Adopt keys and also emit H2 richness now (error.type, status.message, versions) | Larger, mixes contract alignment with new emission behavior; deferred to a later milestone to keep this change reviewable.                     |

## Decision

- **Adopt `span.cli.internal`.** Command spans remain INTERNAL and named by
  `process.executable.name` (the wrapped program basename), which is the
  convention's SHOULD.
- **Rename to the verified v1.37.0 keys.** `process.exit_code` →
  `process.exit.code`; `command.program` → `process.executable.name`; `command.argv` →
  `process.command_args` (retyped to `string[]`); `command.cwd` →
  `process.working_directory`. `process.executable.name` is honestly declared
  `cardinality: high` today: it is also the command span name, and the current
  derivation is a bare `Path::file_name(argv0)` basename with no bound — a
  basename that is "not a path" is not the same as one drawn from a finite set,
  and adversarial or pathological basenames (uuid temp scripts, per-test compiled
  binaries, nix-store-hashed direct-exec) make the span name unbounded. `span.cli`
  explicitly permits a different low-cardinality span-name format provided it is
  documented; M25.1 adds a documented best-effort program-name normalization at
  every emission site, but the cardinality stays formally `high` — because
  wrapped-command names are user-controlled, the normalization cannot bound them,
  so this is a best-effort collapse with a documented residual, not a formal bound.
- **Vendor concepts move under `otel_scrape.*`:** `command.argv_hash` →
  `otel_scrape.command.argv_hash`; `command.cwd_hash` →
  `otel_scrape.command.cwd_hash`; `span.origin` → `otel_scrape.span.origin`.
  `otel.scope.name` stays (it is a standard scope attribute).
- **Privacy travels (reaffirms 0015).** `process.command_args` and
  `process.working_directory` keep `cardinality: high` + `encode: drop` and are
  emitted only into the operator-asserted sink (`--trusted-sink`), never by
  default. This is a required byte-level non-leak regression test, proven by
  negative controls (forcing each gate open makes the non-leak test fail).
- **Pre-align the field shape to #881 (no machinery).** Registry attributes carry
  `stability` (`stable` for `otel.scope.name`, `development` for all `process.*`
  and vendor keys), `examples` on string attributes, first-class
  `cardinality`/`encode` policy fields, and structured `deprecated` on every
  renamed entry. No Weaver flake, Effect-Schema layer, `defineOtelContract` seam,
  or lint is built here.

## Consequences

- `telemetry-registry.json` gains the renamed active keys, the deprecated trail,
  and the #881 field-shape fields; the Rust/TypeScript bindings are regenerated
  via genie. Recorded as an implementation delta.
- Emit sites in `lib.rs` reference the new generated constants; the trust-gated
  raw argv emits as an OTLP `arrayValue` (the always-present correlation hash is
  byte-stable). The byte-level non-leak test asserts array membership of the
  sentinel under `--trusted-sink otlp` and byte-absence everywhere else.
- Requirement R27 and the spec's attribute-key references are updated to the
  semconv keys; the summary's own field names (`argv`/`cwd`/`argv_hash`) are a
  separate local schema and are unchanged.
- **Completed in M25.1 (`span.cli.common` conformance + bounded span name + H2
  richness).** This decision's conformance was partial (see Evidence); M25.1
  closes the named gaps, re-tightens the cardinality, and lands the deferred H2
  richness:
  1. **Best-effort program-name normalization at every emission site;
     `process.executable.name` cardinality remains formally `high`.** The wrapped
     basename is kept verbatim only when it looks like a normal program name —
     length `<= 64`, a conservative safe charset (`[A-Za-z0-9._+-]`), and not a
     content-hash / uuid / long hex-nonce token. A `nix`-store
     `<32-char-nixbase32-hash>-name` prefix is stripped first so a direct-exec of
     `/nix/store/<hash>-foo` is identified as `foo`. Otherwise the name collapses
     to the fallback token `<binary>`, so common pathological inputs (uuid temp
     scripts, per-test compiled binaries, hex nonces) land in one bucket instead
     of an unbounded span name. This same normalization (`bounded_program_name`)
     is applied at BOTH the command-span emission site (span name +
     `process.executable.name`) and the observed-process span emission site, so
     the shared key is normalized everywhere. It is a **best-effort** collapse,
     not a formal bound: wrapped-command names are user-controlled, so residual
     high-entropy names can survive the heuristics — the cardinality is therefore
     honestly declared `high` with a documented residual, not re-tightened to
     `bounded`. `span.cli` explicitly permits a documented low-cardinality
     span-name format; this normalization is the documented best-effort
     approximation of that.
  2. **`process.pid` emitted as a RAW int on the command span.** `process.pid` is
     REQUIRED by `attributes.cli.common`; a pid is not a path, argument, or
     credential, so it is emitted raw (not hashed) and is NOT trust-gated. It is
     the pid of the wrapped direct child (consistent with
     `process.executable.name` naming the child). The existing vendor `pid_hash`
     stays on observed-process spans for descendant-observation correlation — the
     two coexist.
  3. **`error.type` emitted iff `process.exit.code != 0`.** Conditionally required
     by `attributes.cli.common`. Kept LOW cardinality: `otel-scrape` cannot
     classify the wrapped tool's error domain, so it always uses the semconv
     well-known fallback value `_OTHER` (never the exit code or signal, which
     would blow cardinality). Absent on success. Known semconv characteristic: a
     non-zero exit is not always a failure — `grep`/`diff`/test-runners-with-skips
     return non-zero on ordinary outcomes — yet the `span.cli` convention ties
     Error status + `error.type` to `exit.code != 0`, so those runs are marked
     `status = Error` with `error.type = _OTHER`. This is semconv's modeling
     choice, not otel-scrape's; otel-scrape follows the convention rather than
     inventing a per-tool success predicate.
  4. **`status.message` on Error spans.** The Trace API reserves `Description`
     for the Error status, so a bounded, non-sensitive human message is attached
     there: `process exited with code <n>` or `process terminated by signal
<NAME>`. Exit codes and signal names carry no private data, and the
     signal-name set is finite.
  5. **High-resolution timing.** The pre-M25.1 code reconstructed the span end
     from a whole-millisecond duration (`Instant::elapsed().as_millis()`), so
     sub-ms commands were zero-width and every duration was a whole-ms multiple.
     M25.1 keeps the wall-clock anchor (`SystemTime::now()` at unix-nanos) and
     derives the end from the monotonic delta at nanosecond resolution
     (`elapsed.as_nanos()`). The summary keeps its own `duration_ms` field (a
     separate local schema, unchanged). The observed-_process_ span timings
     (`wall_ms` in the observation + summary schema) remain ms-resolution and are
     tracked separately, since changing them would alter the summary schema.
  6. **`scope.version` + `service.version`.** The instrumentation-scope `version`
     (the OTLP scope object) is always set to `otel-scrape`'s crate version
     (`CARGO_PKG_VERSION`), so a trace is unambiguously tied to the wrapper build
     at the scope layer. The resource `service.version` defaults to that same
     crate version **only** when `service.name` is also otel-scrape's own default
     (neither `OTEL_SERVICE_NAME` nor a `service.name` in
     `OTEL_RESOURCE_ATTRIBUTES` was supplied); when a user/harness names the
     enclosing service, otel-scrape does not stamp its own version onto it, and a
     user-supplied `service.version` always wins. These are standard OTel
     placements (scope version field; resource attribute), not vendor attributes,
     so they carry no `telemetry-registry.json` attribute entry.
