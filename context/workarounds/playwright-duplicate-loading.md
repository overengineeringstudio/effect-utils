# Playwright duplicate loading in dotdot setups

## Status

Active investigation. The root cause is understood but the final workaround is not selected.

## Problem statement

Playwright throws `Error: Requiring @playwright/test second time` when a shared config or helper package is linked via `file:` and both the consumer and the linked package resolve their own physical copies of `@playwright/test`. The Playwright runner enforces a singleton load and errors on the second physical path.

In dotdot, this is complicated by symlinked peer repos: Node resolves modules from the real path of the linked repo, not the consumer, so runtime dependencies must exist in the linked repo’s `node_modules`.

## What we learned

- Dotdot links peer repos via `file:` into the consumer’s `node_modules`, but Node resolution follows the real path of the symlink target.
- If the peer repo does not have `node_modules`, runtime deps like `effect` fail to resolve when the Playwright config imports shared code.
- Adding `node_modules` to the peer repo fixes runtime deps but also installs `@playwright/test`, creating a second physical Playwright copy and triggering the duplicate-load error.
- The earlier `playwrightTest` pass-through approach proved insufficient in dotdot because the linked repo still needs its own runtime deps, which forces a second physical Playwright install.

## Constraints

- `@playwright/test` must stay a dev dependency in shared packages (for local testing).
- `NODE_OPTIONS=--preserve-symlinks` does not work here because Node refuses to strip TS types under `node_modules`.
- Playwright’s guard is hard-coded; there is no supported env flag to disable it.

## Reproduction

Repro repo: `/Users/schickling/Code/overengineeringstudio/workspace3/peer-playwright-duplicate`

```
shared-utils/  # imports @playwright/test
consumer/      # imports shared-utils via file:
```

```
cd shared-utils
bun install

cd ../consumer
bun install

bunx playwright test
```

Expected error:

```
Error: Requiring @playwright/test second time
```

## Related issues

- https://github.com/microsoft/playwright/issues/15819 (closed) — Shared package with its own `@playwright/test` causes double load; maintainers point to avoiding duplicate installs.
- https://github.com/microsoft/playwright/issues/31478 (closed) — Two internal packages both importing `@playwright/test` trigger the guard in a consumer project.
- https://github.com/microsoft/playwright/issues/24300 (closed) — Yarn workspace hoisting/deduping resolves duplicate load.
- https://github.com/microsoft/playwright/issues/24564 (closed) — General report of the same guard error in multi-package setups.
- https://github.com/microsoft/playwright/issues/15349 (closed) — Discussion on sharing helpers/config with Playwright Test across packages.
- https://github.com/microsoft/playwright/issues/33159 (closed) — VS Code Test Explorer reports the guard error in a shared fixture setup.
- https://github.com/microsoft/playwright/issues/32959 (closed) — VS Code Test Explorer triggers duplicate load with shared package imports.
- https://github.com/microsoft/playwright/issues/32958 (closed) — Duplicate issue for VS Code Test Explorer error.
- https://github.com/microsoft/playwright/issues/11817 (closed) — Early discussion of using shared fixtures/modules; leads to guidance on avoiding double load.
- https://github.com/oven-sh/bun/issues/3835 (closed) — Bun `file:` dependency behavior can create nested installs.

## Proposed dotdot extension: shared Playwright install

This idea would allow dotdot to avoid duplicate Playwright installs while keeping `@playwright/test` as a dev dependency in shared packages.

### Spec sketch

- Add a new optional field to `dotdot.json` (root + repo-level):
  - `sharedDeps`: map of package name to version range
- `dotdot sync` writes a `dotdot.shared-deps.json` manifest in the workspace root.
- `dotdot install` installs shared deps into a workspace-level store:
  - e.g. `.dotdot/shared-node-modules/node_modules/<package>`
- `dotdot exec` injects `NODE_PATH` pointing to the shared store so Node/Bun resolve the shared deps first.
- `dotdot exec` optionally enforces that shared deps are NOT installed in peer repos (detect and warn).

### Requirements

- Must work with ESM resolution for Node and Bun.
- Must ensure a single physical install path for singleton-sensitive packages (Playwright).
- Must keep peer repo installs isolated for all other deps.

### Constraints

- `NODE_OPTIONS=--preserve-symlinks` fails for TS sources under `node_modules`.
- Playwright guard cannot be disabled; single physical path is required.
- Bun recommends isolated installs in dotdot setups (no auto-hoisting).

### Open questions

- Does Playwright’s loader honor `NODE_PATH` for ESM imports when run via `bunx playwright`?
- Can dotdot inject `NODE_PATH` consistently for all test/dev commands (including IDE integrations)?
- Should shared deps be installed per workspace or per repo group?
- How should dotdot handle version conflicts across repos for shared deps?
- How do we ensure shared deps are never duplicated in peer repos (warn vs auto-prune)?

## Other candidate solutions

- Install shared packages as tarballs/registry packages (avoid `file:` symlink resolution).
- Inline Playwright config in consumers (avoid shared helper import).

## References

- Playwright guard implementation: https://github.com/microsoft/playwright/blob/37d58bd440ea06966c98508714854563db46df0a/packages/playwright/src/index.ts#L25-L43
