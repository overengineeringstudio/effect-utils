# Replica export replaces raw dump

Status: accepted

The CLI no longer exposes a raw `notion db dump` command or a compatibility
path for the old raw Notion NDJSON exporter. Canonical database export is
`notion db export`, derived from the established replica contract rather than
from a separate live Notion query path.

`notion db export` may establish or refresh a local replica when explicitly
given a remote Notion reference, but it still exports from the replica contract.
It must not call a separate raw Notion dump path.

This keeps one source of truth for exportable data: Notion observation produces
sync events, events project into the public replica, and export reads that
replica. Removing raw dump also avoids preserving property-name identity,
wall-clock dump checkpoints, raw block payloads, and asset-crawling behavior as
parallel long-term APIs.
