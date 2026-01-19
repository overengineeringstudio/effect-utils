# Bun Issues

## Bun install hang bug

- [bun install frequently hangs in monorepo (isolated linker) — no progress, no error, even with --verbose](https://github.com/oven-sh/bun/issues/22846)

Current workaround: `bun install --no-cache` seems to work but is much slower.

## Bun patchedDependencies bug

- [Patching falls over when using local path dependencies](https://github.com/oven-sh/bun/issues/13531)
