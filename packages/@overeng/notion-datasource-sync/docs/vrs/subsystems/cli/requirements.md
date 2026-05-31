# CLI Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **CLI-R01 CLI commands:** The package must provide CLI commands for init, pull, status, push, sync, `sync --watch`, conflicts, migrate, doctor, repair, forget, and restore. There is no standalone user-facing `watch` command.
- **CLI-R02 Dry-run plans:** Mutating commands must support dry-run output that shows planned events, conflicts, outbox commands, and guard failures.
- **CLI-R03 Machine output:** CLI output must support structured machine-readable mode for CI and agent workflows.
- **CLI-R04 Human diagnostics:** CLI output must provide concise human-readable explanations for conflicts, blocked guards, retries, tombstones, and migrations.
- **CLI-R05 Sync progress:** Long-running sync commands must always expose live sync progress for humans, including phase and bounded progress-bar state, without corrupting stdout machine-readable result output.
