# CLI Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **CLI-R01 CLI commands:** The public `notion db` surface must provide commands for track, sync, `sync --watch`, status, doctor, conflicts, forget, restore, and export. `track` is the only public command that accepts a Notion data-source id or database URL for adoption; established `sync` operates on local workspace roots. Init, pull, and push are internal reconciliation phases, not public commands. There is no standalone user-facing `watch` command, `sync --from-notion` adoption mode, public `init`/`pull`/`push`, `notion sqlite` namespace, `notion db replica` namespace, `notion db dump` command, public `migrate` or `repair` command, standalone `notion-datasource-sync` public binary, or raw Notion dump compatibility path.
- **CLI-R02 Dry-run plans:** Mutating commands must support dry-run output that shows planned events, conflicts, outbox commands, and guard failures.
- **CLI-R03 Machine output:** CLI output must support structured machine-readable mode for CI and agent workflows.
- **CLI-R04 Human diagnostics:** CLI output must provide concise human-readable explanations for conflicts, blocked guards, retries, tombstones, and migrations.
- **CLI-R05 Sync progress:** Long-running sync commands must always expose live sync progress for humans, including phase and bounded progress-bar state, without corrupting stdout machine-readable result output.
