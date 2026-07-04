# Requirements: deadnix adapter

Role: a thin diagnostics adapter mirroring oxlint. This leaf states only
deadnix-specific testable constraints; inherited rules are not restated.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and the parent
  contract [../../requirements.md](../../requirements.md).
- Mirrors the reference [../01-oxlint/requirements.md](../01-oxlint/requirements.md).
- Source evidence: [../.experiments/0003-deadnix-json.md](../.experiments/0003-deadnix-json.md).

## Requirements

- **ADP.DEADNIX-R01 Non-mutating, exit-preserving injection** (refines parent
  R03): the adapter injects only `--output-format json`. It never injects
  `--fail` (which would change the passthrough exit code) nor `--edit` (the only
  writing flag).
- **ADP.DEADNIX-R02 No derived kind, no message in sinks** (refines parent R08,
  R27): because deadnix exposes no machine-readable kind/severity field, sink
  records carry no derived kind beyond at most a single constant category; the
  `message` (which contains the dead symbol's source name) and the `file` path
  never enter a sink, and `column`/`endColumn` (identifier-length leak) are
  dropped from sinks.
- **ADP.DEADNIX-R03 Empty-output is zero findings** (refines parent R07): a file
  with no dead code emits zero bytes; the adapter treats an empty stream as zero
  findings — no events, no error.
- **ADP.DEADNIX-R04 Count as span attribute** (refines ADP-R06): `deadnix.findings`
  is exposed as a command-span attribute. This is the adapter's primary OTLP
  value; without it the run contributes only thin hashed-file/line events.
