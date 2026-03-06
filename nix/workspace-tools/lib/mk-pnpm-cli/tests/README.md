# mk-pnpm-cli Test Harness

End-to-end smoke coverage for the `mk-pnpm-cli` builder.

The harness builds the real `genie` and `megarepo` package outputs through Nix
and verifies that the resulting binaries start successfully.

## Run

```bash
bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh
```

## Benchmark

Compare the current worktree against its merge-base with `origin/main` in a
detached baseline worktree:

```bash
bash nix/workspace-tools/lib/mk-pnpm-cli/tests/benchmark.sh
```

## Options

- `--system <system>` - Override the Nix system
- `--skip-genie` - Skip the `genie` build
- `--skip-megarepo` - Skip the `megarepo` build
- `--baseline-ref <ref>` - Override the baseline git ref for the benchmark
- `--repeats <n>` - Override the number of rebuilds per ref/package for the benchmark
