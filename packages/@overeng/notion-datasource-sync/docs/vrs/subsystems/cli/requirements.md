# CLI Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **CLI-R01 CLI commands (was R48):** The package must provide CLI commands for init, pull, status, push, sync, `sync --watch`, conflicts, migrate, doctor, repair, forget, and restore. There is no standalone user-facing `watch` command.
- **CLI-R02 Dry-run plans (was R49):** Mutating commands must support dry-run output that shows planned events, conflicts, outbox commands, and guard failures.
- **CLI-R03 Machine output (was R50):** CLI output must support structured machine-readable mode for CI and agent workflows.
- **CLI-R04 Human diagnostics (was R51):** CLI output must provide concise human-readable explanations for conflicts, blocked guards, retries, tombstones, and migrations.
- **CLI-R05 Sync progress (was R51a):** Long-running sync commands must always expose live sync progress for humans, including phase and bounded progress-bar state, without corrupting stdout machine-readable result output.
