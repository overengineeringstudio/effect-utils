# Requirements: vitest adapter

Role: a supported phase/test adapter using a side-channel source. Documented from
the implementation (`packages/@overeng/otel-scrape/src/lib.rs`), not part of the
fleet audit. This leaf states only vitest-specific testable constraints.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and the parent
  contract [../../requirements.md](../../requirements.md).
- Governed by parent decision
  [../../.decisions/0017-adapter-structured-source-and-presentation.md](../../.decisions/0017-adapter-structured-source-and-presentation.md)
  (vitest is the canonical **side-channel** example).

## Requirements

- **ADP.VITEST-R01 Side-channel, no re-render** (refines parent R30): the adapter
  reads a JSON report the child writes to a file while vitest's human reporter
  still writes to the terminal. Because the structured source does not replace
  human stdout, the adapter owes no re-presentation.
- **ADP.VITEST-R02 Respect user reporter/output** (refines parent R30): a
  pre-existing `--outputFile.json` is read in place and **never deleted** (operator
  data loss); a user-supplied `--reporter` is preserved rather than overridden.
- **ADP.VITEST-R03 Empty/unparseable source degrades** (refines parent R07): an
  empty or unparseable report yields no records, not an error.
