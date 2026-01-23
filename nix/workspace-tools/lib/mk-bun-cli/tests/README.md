# mk-bun-cli Test Harness

Self-contained fixtures + runner to exercise mk-bun-cli across:

- effect-utils builds (workspace + standalone)
- peer fixture builds (workspace + standalone)
- megarepo-local workspace generation
- nested megarepo root selection
- devenv entrypoints

The runner creates a temporary megarepo root in a global temp directory and
removes it unless `--keep` is set.

## Run

```bash
bash effect-utils/nix/workspace-tools/lib/mk-bun-cli/tests/run.sh
```

## Options

- `--workspace <path>` - Use a fixed temp workspace directory
- `--keep` - Keep the temp workspace for inspection
- `--skip-effect-utils` - Skip building effect-utils CLI
- `--skip-peer` - Skip building the peer fixture
- `--skip-devenv` - Skip devenv validation
- `--skip-nested` - Skip nested megarepo validation

## Notes

- The harness uses `mr sync` + `mr generate nix` to populate
  `.direnv/megarepo-nix/workspace` and builds via
  `path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.<repo>.<target>`.
- Devenv validation overrides `effect-utils` to the generated workspace mirror
  to avoid path input issues with `.devenv.flake.nix`.
- All builds use `--no-link` to avoid `result` symlinks in the workspace.
- The peer fixture uses a local file dependency (`shared-lib`) within the repo
  to exercise local deps handling.
