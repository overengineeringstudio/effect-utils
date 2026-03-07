# mk-pnpm-cli Test Harness

End-to-end smoke coverage for the `mk-pnpm-cli` builder.

The harness builds the real `genie` and `megarepo` package outputs through Nix
and verifies that the resulting binaries start successfully. It also runs the
same `pnpm deploy --config.inject-workspace-packages=true --frozen-lockfile`
shape used by the builder against the real package lockfiles.

## Run

```bash
bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh
```

## Options

- `--system <system>` - Override the Nix system
- `--skip-genie` - Skip the `genie` build
- `--skip-megarepo` - Skip the `megarepo` build
