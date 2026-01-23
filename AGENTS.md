# Sensitive Information

- `effect-utils` is a public repository but used in the context of private repositories. It's very important to never commit sensitive information to this repository including information from/about private repositories.

# Development Commands

Use `dt <task>` (devenv tasks) to execute tasks with dependencies:

- **TypeScript**: `dt ts:check` or `dt ts:watch` (watch mode) or `dt ts:clean`
- **Linting**: `dt lint:check` or `dt lint:fix`
- **Testing**: `dt test:run` (all) or `dt test:<pkg>` (single package) or `dt test:watch` or `dt test:integration`
- **Build**: `dt ts:build`
- **Install**: `dt bun:install`
- **Genie**: `dt genie:run` or `dt genie:watch` or `dt genie:check`
- **Check all**: `dt check:quick` (ts + lint) or `dt check:all` (ts + lint + test)

The `mono` CLI is only used for `mono nix *` and `mono context *` commands.

If tools aren't directly in `$PATH`, prefix commands with `direnv exec .` (e.g., `direnv exec . dt ts:check`).

We're using megarepo for repo management. We're using `bun` (not `pnpm`) as the package manager and `devenv` to manage the development environment.

# Genie (Config File Generation)

Config files like `package.json`, `tsconfig.base.json`, and `.github/workflows/ci.yml` are generated from TypeScript source files using genie. The source files have a `.genie.ts` suffix (e.g., `package.json.genie.ts`).

- **Never edit generated files directly** - they are read-only and will be overwritten
- **Edit the `.genie.ts` source file** and run `dt genie:run` to regenerate
- Shared constants (catalog versions, tsconfig options) live in `genie/repo.ts`
- `dt check:quick` verifies generated files are up to date via `dt genie:check`

# Changelog

Keep `CHANGELOG.md` updated:

- Add entries under `[Unreleased]` when making changes
- When cutting a release, move `[Unreleased]` entries to a new version section with the release date

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
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
