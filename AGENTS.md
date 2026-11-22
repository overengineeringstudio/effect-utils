# Sensitive Information

- `effect-utils` is a public repository but used in the context of private repositories. It's very important to never commit sensitive information to this repository including information from/about private repositories.

# Language choice

Rust is the default for build/infra tooling, engines, and host-state CLIs. TypeScript needs a reason and means Effect; plain TS is only for trivial glue/config.
Repo exceptions: the genie engine and `*.genie.ts` authoring stay TS; JS-runtime adapters (e.g. Bun build in buck2-tools) stay TS.
Remaining buck2-tools TS modules are legacy, maintained in place, and move only on the triggers in [#1522](https://github.com/overengineeringstudio/effect-utils/issues/1522), not proactively.
Content-address is planned as an Effect contract plus a Rust byte engine; interop remains a draft design.
The fleet policy is maintained in the maintainers' dotfiles.

# Development Commands

For package-local SCG source feedback without devenv, use
`bash scripts/package-feedback.sh packages/@overeng/scg-<package>`.
See [the measured loop and prerequisites](context/ci/scg-feedback.md).
This does not replace Buck or the exact-head `check:quick` merge receipt.

Use Buck for check verdicts; retained devenv tasks handle setup and the broader suites:

- **TypeScript**: `python3 scripts/worktree-env.py run -- buck2 build //:quick` after the explicit preparation below.
- **Declaration publication**: `devenv tasks run buck2:typescript:materialize-dist`
- **Linting**: `devenv tasks run lint:check` or `devenv tasks run lint:fix`
- **Testing**: `devenv tasks run test:run` (all) or `devenv tasks run test:<pkg>` (single package) or `devenv tasks run test:watch`
- **Dependencies**: `devenv tasks run buck2:editor:publish`
- **Genie**: `devenv tasks run genie:run` or `devenv tasks run genie:watch` or `devenv tasks run genie:check`
- **Quick check**: `python3 scripts/worktree-env.py run -- buck2 run //:check-quick` after full-profile preparation below. Broader checks still use `devenv tasks run check:all`.

For devenv commands, `--no-tui` shows all output. Buck uses the explicit Nix-built PATH preparation below rather than entering `devenv shell` for each command.

We're using megarepo for repo management. We're using `pnpm` temporarily for installs (bun is still used to run scripts) and `devenv` to manage the development environment.

Buck owns checking for every TypeScript project and declaration production for every emitting project. The checkout itself is the standalone Buck root: `//:quick` is the deterministic aggregate and `//:check-quick` adds the full local checkout contracts. Option D and retained devenv callers use the pinned guarded Buck. `buck2:typescript:materialize-dist` publishes declarations atomically when source-side tools or editors need package `dist` trees.

Agents/CI can prepare the narrow Nix-built PATH with
`python3 scripts/worktree-env.py prepare` under normal build admission, then use
`python3 scripts/worktree-env.py run -- buck2 build //:quick`, or the published
`.worktree-tools/v1/current/tools/bin/buck2` directly. New source files must
be staged first because Nix's Git source excludes untracked files. Dirty tracked
changes are supported. Missing, stale or GC'd projections refuse with the repair
command rather than falling back to ambient tools. Preparation is explicit and
does not install dependencies, hooks, secrets or services. The existing devenv
tasks remain available; `build //:quick` alone is not full `check:quick` parity.
For the complete quick contract, evaluate the retained task/tool authority once:
`WORKTREE_CAPABILITIES_PROFILE="$(devenv build effectUtils.quickContracts.capabilities --no-tui | python3 -c 'import json,sys; print(json.load(sys.stdin)["effectUtils.quickContracts.capabilities"])')"`
then `export WORKTREE_CAPABILITIES_PROFILE` and run `python3 scripts/worktree-env.py prepare`.
This full-profile setup explicitly runs the retained standalone source-staging
task; the subsequent `buck2 run //:check-quick` owns all check verdicts and
reuses the authenticated published profile in fresh terminals. Refresh after
source changes. The legacy `devenv tasks run check:quick` remains available until
full cross-platform parity is proved; no devenv tasks are removed.
This live run retains caller-owned policy/identity/trace context. Its real admission
lifecycle guard requires the operator's Nix-installed `gate-slot`; only that immutable
package and agent-policy guard directories are retained, never ambient compiler paths.
Build/test/run retain the existing Buck identity/converter/export boundary and
emit a real environment entry span when OTLP delivery is configured. Pipeline
spools remain pipeline-owned; standalone evidence is retained under `.worktree-tools/otel`.
Immutable tool generations are rooted until normal safe worktree teardown.

# Worktree removal

Before removing a worktree, close its editors/builds and run the installed `worktree-teardown <worktree-path>` command from outside it, then run `git worktree remove`. The command is exported as the effect-utils flake's `worktree-teardown` package; it does not realize the retiring checkout's shell. Only editor-free checkouts skip editor release without explicit `WORKTREE_TEARDOWN_EDITOR_RELEASE=1` (Nix builds remain disabled).
Without release opt-in, any owned `.editor-view` (including lease-only state) refuses with exit 3 before mutation; rerun with `WORKTREE_TEARDOWN_EDITOR_RELEASE=1` instead of removing that worktree.
Never use `chmod -R` or `rm -rf` on an effect-utils worktree: editor-view snapshot files are hardlinks into the shared content store, and changing their mode corrupts the store for every worktree.
See [buck2-tools retired worktree removal](packages/@overeng/buck2-tools/README.md#retired-worktree-removal) and [#2041](https://github.com/overengineeringstudio/effect-utils/issues/2041).

# Genie (Config File Generation)

Config files like `package.json`, `tsconfig.base.json`, and `.github/workflows/ci.yml` are generated from TypeScript source files using genie. The source files have a `.genie.ts` suffix (e.g., `package.json.genie.ts`).

- **Never edit generated files directly** - they are read-only and will be overwritten
- **Edit the `.genie.ts` source file** and run `devenv tasks run genie:run` to regenerate
- Shared constants and compiler options live in `genie/external.ts`, re-exported by `genie/internal.ts`
- `devenv tasks run check:quick` verifies generated files are up to date via `devenv tasks run genie:check`

# Breaking Changes

Agents must not create a root `CHANGELOG.md`.

There is no changelog file; commits and PRs are the change record. For a breaking change:

- Mark the commit/PR title with `!` (e.g. `feat(buck2)!: require cargo_env in reindeer.toml`)
- Add a `BREAKING CHANGE:` footer with the migration steps, and repeat them in the PR description

# Task Management

Use GitHub issues or an issue checklist for non-trivial work.

- Link the issue in the PR when the repo workflow expects it
- File follow-up GitHub issues for out-of-scope work discovered during implementation

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
