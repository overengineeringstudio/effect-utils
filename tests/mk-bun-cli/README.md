# mk-bun-cli Test Harness

Self-contained fixtures + runner to exercise `mk-bun-cli` across:

- effect-utils itself (monorepo build)
- peer repos via dotdot workspace root
- Nix flakes + devenv
- clean vs dirty sources

The runner creates a temporary dotdot-style workspace in a global temp
location and cleans it up unless `--keep` is set.

## Run

```bash
bash effect-utils/tests/mk-bun-cli/run.sh
```

## Options

- `--dirty` - Rebuild after modifying a peer source file
- `--keep` - Keep the temp workspace for inspection
- `--workspace <path>` - Use a fixed temp workspace directory
- `--refresh-locks` - Run `bun install` in fixtures to refresh bun.lock
- `--skip-effect-utils` - Skip building effect-utils CLIs
- `--skip-peer` - Skip building the peer fixture
- `--skip-devenv` - Skip devenv validation
- `--link-effect-utils` - Symlink effect-utils into the temp workspace

## Notes

- Fixtures use `pkgs.lib.fakeHash` for `bunDepsHash`; the runner replaces it
  with the computed hash inside the temp workspace.
- Dirty mode updates a peer repo file and rebuilds to verify local changes
  are picked up without commits (it sets `dirty = true` in the fixture
  mkBunCli call and runs `nix flake update workspace` to refresh the input).
- Devenv validation pins inputs with `--override-input` to avoid `path:../`
  resolving to `/nix/store` when evaluated from the store.
