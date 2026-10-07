# Sensitive Information

- `effect-utils` is a public repository but used in the context of private repositories. It's very important to never commit sensitive information to this repository including information from/about private repositories.

# Language choice

Rust is the default for build/infra tooling, engines, and host-state CLIs. TypeScript needs a reason and means Effect; plain TS is only for trivial glue/config.
Repo exceptions: the genie engine and `*.genie.ts` authoring stay TS; JS-runtime adapters (e.g. Bun build in buck2-tools) stay TS.
Remaining buck2-tools TS modules are legacy, maintained in place, and move only on the triggers in [#1522](https://github.com/overengineeringstudio/effect-utils/issues/1522), not proactively.
Content-address is planned as an Effect contract plus a Rust byte engine; interop remains a draft design.
The fleet policy is maintained in the maintainers' dotfiles.

# Development Commands

Use `devenv tasks run <task>` (devenv tasks) to execute tasks with dependencies:

- **TypeScript**: `devenv tasks run buck2:quick`
- **Declaration publication**: `devenv tasks run buck2:typescript:materialize-dist`
- **Linting**: `devenv tasks run lint:check` or `devenv tasks run lint:fix`
- **Testing**: `devenv tasks run test:run` (all) or `devenv tasks run test:<pkg>` (single package) or `devenv tasks run test:watch`
- **Dependencies**: `devenv tasks run buck2:editor:publish`
- **Genie**: `devenv tasks run genie:run` or `devenv tasks run genie:watch` or `devenv tasks run genie:check`
- **Check all**: `devenv tasks run check:quick` or `devenv tasks run check:all`

Use the `--no-tui` flag to see all output. If tools aren't directly in `$PATH`, enter the dev environment first with `devenv shell`.

We're using megarepo for repo management. We're using `pnpm` temporarily for installs (bun is still used to run scripts) and `devenv` to manage the development environment.

Buck owns checking for every TypeScript project and declaration production for every emitting project. The checkout itself is the standalone Buck root; CI and devenv invoke the `//:quick` aggregate through the pinned `BUCK2_BIN`. `buck2:typescript:materialize-dist` publishes declarations atomically when source-side tools or editors need package `dist` trees.

# Genie (Config File Generation)

Config files like `package.json`, `tsconfig.base.json`, and `.github/workflows/ci.yml` are generated from TypeScript source files using genie. The source files have a `.genie.ts` suffix (e.g., `package.json.genie.ts`).

- **Never edit generated files directly** - they are read-only and will be overwritten
- **Edit the `.genie.ts` source file** and run `devenv tasks run genie:run` to regenerate
- Shared constants (catalog versions, tsconfig options) live in `genie/repo.ts`
- `devenv tasks run check:quick` verifies generated files are up to date via `devenv tasks run genie:check`

# Changelog

Every PR adds a new `changelog.d/<branch-slug>.<section>.md` fragment with
Markdown bullets. Sections are `added`, `fixed`, `changed`, and `removed`.
Do not edit the shared `CHANGELOG.md` Unreleased section in ordinary PRs.
For no user-facing changes, put `Changelog-None: <reason>` in the latest commit's
Git trailers. The required `pr/quality` check enforces coverage.

See [changelog.d/README.md](changelog.d/README.md) for naming, exemptions and
migration. Release maintainers run `devenv tasks run changelog:assemble` before
cutting the release heading, committing the log and consumed-fragment deletions
together. `changelog:check` validates fragments and `changelog:test` tests tooling.

# Breaking Changes

For a breaking change, include migration instructions in the changelog fragment and:

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
