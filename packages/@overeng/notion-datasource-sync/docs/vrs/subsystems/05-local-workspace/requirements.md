# Local Workspace Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **FS-R01 Path-claim authority:** Path claims, not file names, are the source of truth for local workspace ownership; a local path has at most one active owning page, renames append path-claim events, and materialization must never overwrite another page's claim.
- **FS-R02 Path safety:** Canonical paths must be root-relative POSIX-style after Unicode NFC normalization; empty, dot, dot-dot, separator, control-character, and reserved segments must be rejected or escaped before claim, and materialization and scans must not follow symlinks outside `localRoot`.
