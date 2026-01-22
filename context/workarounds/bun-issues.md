# Bun Issues

## Bun install hang bug

- [bun install frequently hangs in monorepo (isolated linker) — no progress, no error, even with --verbose](https://github.com/oven-sh/bun/issues/22846)

Current workaround: `bun install --no-cache` seems to work but is much slower.

## Bun `file:` dependency slowness

Using `file:../path` dependencies is extremely slow (6-35+ seconds per package) because bun creates individual symlinks for **every file** in the target package, rather than a single symlink to the package root.

**Relevant issues:**
- [#13223 - bun install on projects with file: dependencies is very slow](https://github.com/oven-sh/bun/issues/13223)
- [#23453 - file protocol in package.json dependency](https://github.com/oven-sh/bun/issues/23453) (tracked internally as ENG-20854)
- [#25202 - bun i never exits, spikes cpu and memory on local file dependency](https://github.com/oven-sh/bun/issues/25202)

**Benchmarks (example monorepo with local file: deps):**
| Package | Registry Deps | Local `file:` Deps | Fresh Install Time |
|---------|---------------|--------------------|--------------------|
| `@example/shared` | 2 | 0 | 7ms |
| `@example/utils` | 143 | 0 | 441ms |
| `@example/common` | 216 | 3 | 6.5s |
| `@example/cli` | 267 | 6 | 35s |

**Solution:** Use `workspace:*` protocol instead of `file:` - workspaces create a single symlink to the package root.

```json
// Slow (symlinks every file)
"@example/utils": "file:../utils"

// Fast (single symlink to package root)
"@example/utils": "workspace:*"
```

Requires setting up a root `package.json` with workspaces config.

## Bun patchedDependencies bug

- [Patching falls over when using local path dependencies](https://github.com/oven-sh/bun/issues/13531)
