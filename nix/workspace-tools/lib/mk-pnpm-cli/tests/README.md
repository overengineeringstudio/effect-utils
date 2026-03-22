# mk-pnpm-cli Test Harness

End-to-end smoke and downstream composition coverage for the `mk-pnpm-cli`
builder.

The harness builds the real `genie` and `megarepo` package outputs through Nix
and verifies that the resulting binaries start successfully. The downstream
fixture also covers `oxlint-npm`, because its bundled `oxc-config` plugin uses
the same prepared-tree machinery through a different entry path.

It also exercises the issue-421 regression shape by creating a tiny downstream
flake that consumes `inputs.effect-utils.packages` and overrides the input
through both:

- a standalone checkout path
- a composed `repos/effect-utils` path

The downstream fixture follows `effect-utils/nixpkgs`, which is the canonical
consumption pattern for prepared pnpm trees in downstream repos.

## Run

```bash
bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh
```

## Options

- `--system <system>` - Override the Nix system
- `--workspace <path>` - Use a fixed temp workspace for downstream coverage
- `--keep` - Keep the temp workspace after the run
- `--skip-genie` - Skip the `genie` build
- `--skip-megarepo` - Skip the `megarepo` build
- `--skip-oxlint` - Skip downstream `oxlint-npm` coverage
- `--skip-downstream` - Skip downstream flake-input regression coverage
