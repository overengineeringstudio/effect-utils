# CLI Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **CLI-R01 CLI commands:** The public `notion db` surface must provide commands for sync, `sync --watch`, status, doctor, conflicts, forget, restore, export, and advanced init/pull/push/migrate/repair workflows when promoted. There is no standalone user-facing `watch` command. Retired legacy namespaces and raw export paths are governed by [decision 0007](../../decisions/0007-replica-export-replaces-raw-dump.md) and [decision 0008](../../decisions/0008-single-database-cli-surface.md).
- **CLI-R02 Dry-run plans:** Mutating commands must support dry-run output that shows planned events, conflicts, outbox commands, and guard failures.
- **CLI-R03 Machine output:** CLI output must support structured machine-readable mode for CI and agent workflows.
- **CLI-R04 Human diagnostics:** CLI output must provide concise human-readable explanations for conflicts, blocked guards, retries, tombstones, and migrations.
- **CLI-R05 Sync progress:** Long-running sync commands must always expose live sync progress for humans, including phase and bounded progress-bar state, without corrupting stdout machine-readable result output.
