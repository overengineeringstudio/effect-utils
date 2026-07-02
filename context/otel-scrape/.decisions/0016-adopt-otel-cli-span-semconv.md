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
  trust-gated raw *display* value changes shape.
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

| Option                                                            | Consequence                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the invented `command.*` keys (status quo)                   | Stable, but a process wrapper that ignores the process semconv; the biggest "not SOTA" signal, and argv stays a lossy newline-joined string.    |
| Adopt upstream keys but make raw argv/cwd always-on standard fields | Maximally "standard", but silently converts a public-substrate footgun into the default — leaks argv/paths to any shared sink. Rejected.        |
| **Adopt upstream keys + types; privacy travels with the rename (chosen)** | Speaks the process semconv and fixes the array lossiness, while the 0015 trust gate stays bound to the renamed raw keys. Contract-only change. |
| Adopt keys and also emit H2 richness now (error.type, status.message, versions) | Larger, mixes contract alignment with new emission behavior; deferred to a later milestone to keep this change reviewable.                      |

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
  documented; M25.1 enforces a documented low-cardinality program-name derivation
  and re-tightens this key to `bounded`.
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
- **Deferred to M25.1 (completes `span.cli.common` conformance and the bounded
  span name).** This decision's conformance is partial (see Evidence); the two
  named gaps and the cardinality re-tightening land in M25.1:
  1. **Enforce a bounded program-name derivation and re-tighten
     `process.executable.name` to `cardinality: bounded`.** The current
     `Path::file_name(argv0)` basename is unbounded (declared `high` here); M25.1
     enforces a documented low-cardinality span-name format (which `span.cli`
     explicitly permits) and re-tightens the registry cardinality.
  2. **Emit `process.pid` as a RAW int on the command span.** `process.pid` is
     REQUIRED by `attributes.cli.common`; a pid is not a path, argument, or
     credential, so it is emitted raw (not hashed). The existing vendor
     `pid_hash` stays for descendant-observation correlation — the two coexist.
  Also deferred is `error.type` (conditionally-required by `attributes.cli.common`).
- Remaining H2 richness (`status.message`, `scope.version`, `service.version`,
  high-resolution clock) is out of scope here and tracked separately from the
  M25.1 conformance gaps above.
