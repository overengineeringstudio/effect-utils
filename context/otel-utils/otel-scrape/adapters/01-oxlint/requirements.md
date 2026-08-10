# Requirements: oxlint adapter

Role: the reference diagnostics adapter. This leaf states only oxlint-specific
testable constraints; the adapter contract, source-kind classification, and
public-safe rules are inherited and not restated.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and, through it,
  the parent contract [../../requirements.md](../../requirements.md).
- Source evidence: [../.experiments/0001-oxlint-source.md](../.experiments/0001-oxlint-source.md).

## Requirements

- **ADP.OXLINT-R01 Gated JSON source** (refines ADP-R02, parent R08): the adapter
  consumes `oxlint --format=json`; the flag is injected only alongside the
  otel-scrape prefix, so a repo without otel-scrape never sees raw JSON on its
  terminal.
- **ADP.OXLINT-R02 Fixed sink record** (refines parent R27): the only fields that
  reach any sink for a diagnostic are `severity`, `filename_hash`, `rule`
  (code), and `line`, plus the run-level `diagnostics` count. Raw `message`,
  `filename`/path, `help`, `url`, `causes`, and `column`/`offset` never enter a
  sink, including the summary.
- **ADP.OXLINT-R03 Non-degrading passthrough** (refines parent R30): when stdout
  is not parseable JSON, the captured bytes are flushed unmodified — output is
  never swallowed — and no records are emitted.
- **ADP.OXLINT-R04 Count as span attribute** (refines ADP-R06): the `diagnostics`
  total (and, if adopted, `errors`/`warnings`) is exposed as a command-span
  attribute so it reaches OTLP without the currently-dropped metric path.
