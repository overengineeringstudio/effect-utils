# Operational notes for writing Phase 1 baselines

Techniques and traps accumulated while capturing the Effect 3 baselines that gate the Effect 4
cohort flip (#925). Written down because each was discovered the expensive way, and most are
invisible until they bite.

The recurring theme: **several failure modes here look exactly like success.** A test task that
does not exist, a test file that is never collected, and a validation command that does not run
tests all present as green.

## Validation

**`check:quick` is TypeScript + lint only. It does not run tests.** For a test-only PR it proves
almost nothing. It was cited as validation on many baseline PRs before this was noticed.

The real signal, on a **committed** worktree:

```sh
CI=1 devenv tasks run test:<pkg> --mode single --show-output --no-tui
```

**Confirm the test count, not the exit code.** Exit 0 is compatible with collecting zero tests.
Read the newest `tmp/otel-scrape/summaries/test-<pkg>*.summary.json` and check `vitest.tests` and
`vitest.failures`.

**Commit before validating.** Some output only appears post-commit — `megarepo` and `ci-tools`
embed `running from local source (<sha>, <age>)` in help and version output, absent in a dirty
tree. PR #991 passed when opened and failed later for exactly this reason.

**Repeated task runs can be cached.** When proving flake resistance with multiple invocations, the
devenv task cache can silently return a stale empty `{}` result after the first real run. Use
`--refresh-task-cache` for counted repeats, and still read each fresh summary JSON before trusting
the pass rate.

## Test tasks must exist

`devenv.nix` generates a `test:<pkg>` task only for packages listed in `packagesWithTests`. There is
no root vitest run in the task graph, so **a package absent from that list is never tested by CI**,
however green everything looks. Four packages were in that state; #992 adds them.

To validate a baseline for a package whose task does not yet exist on `main`, build a
verification-only worktree rather than stacking the wiring into the baseline PR:

1. fresh `branchy` worktree from your committed baseline
2. cherry-pick the wiring commit (`6a4792019` for #992)
3. `pnpm:install` against the committed lock
4. run `test:<pkg>` and read the summary JSON

## Vitest collection

Include patterns are **package-relative and differ per package**. Invoking Vitest from the repo root
can report _no tests_ while appearing to pass. Observed: `tui-stories` uses `test/**`,
`notion-datasource-sync` uses `src/**/*.test.ts`.

Most packages need **no** `vitest.config.ts` — repo convention is that it exists only where genuinely
required. The two form packages are the exception: the root workspace config resolves projects
relative to the package task cwd and fails at startup there, so each needs a minimal local config
(`src/**/*.unit.test.ts[x]`) with a one-line comment explaining why. **Do not add one unless the
package task proves it is needed** — an unnecessary config is future confusion.

## Lockfile changes cascade across FODs

A dev-dependency addition invalidates every lockfile-derived fixed-output derivation — **eight** of
them (`flake.nix:199-214`). `evergreen fod chase-fod-closure` cannot help: it requires
`passthru.evergreen.fodGraph.v1` metadata the consumers lack. Refresh per attr instead.

Patched dependencies are part of the same authority boundary. Treat `.patch` files as opaque generated
artifacts: put live-migration markers on the wiring that references a patch, never inside its
whitespace-sensitive body. Adding, removing, or regenerating a patch changes the bytes included by the
`oxc-config-plugin` FOD and changes the patch hashes throughout `pnpm-lock.yaml`. Regenerate the
lockfile first, prove every patch still applies, and then refresh all eight attrs. A branch merge that
combines patch changes needs another refresh against the merged graph; updating only the first hash
reported by Nix leaves the remaining boundaries stale.

Package attrs:

```sh
evergreen fod --hash-source packages/@overeng/<pkg>/nix/build.nix \
  --flake-ref .#<pkg> refresh --name <pkg>-unwrapped --linux-system x86_64-linux
```

Plugin bundle:

```sh
evergreen fod --hash-source nix/oxc-config-plugin.nix \
  --flake-ref .#oxc-config-plugin-pnpm-deps refresh \
  --name oxc-config-plugin-pnpm-deps --linux-system x86_64-linux
```

Post-write warnings about `build.nix` requiring `src` are expected. Verify **exactly** those eight
files changed — anything else is drift, not our cascade. `nix build .#oxlint-npm --no-link` verifies
the plugin bundle. All refreshed hashes belong in the **same PR** as the dependency change that
caused them; splitting leaves `main` unbuildable between merges.

## Lint

The gate lints `packages`, `scripts`, `context` only — not `genie/` or root `*.genie.ts`, which
carry pre-existing errors (#995). A bare repo-wide `oxlint` therefore reports failures the gate does
not enforce.

The instrumented lint task catches rules that a direct `oxlint` invocation does not — it flagged a
deprecated Vitest `toThrowError` (use `toThrow`) that direct linting missed. It also identifies the
offending file by **filename hash rather than path**, which makes a real single-line error present
as "nonzero with no readable diagnostics".

## What gets a migration marker

Baselines are **permanent gates**, so they carry no `LIVE-MIGRATION BRIDGE` block. A specific
assertion that pins v3 behaviour we expect v4 to change gets an inline
`TODO(live-migration:effect-3-4)` instead — resolved rather than deleted. Only genuinely temporary
workarounds get bridge blocks. See the bridge register in #925.
