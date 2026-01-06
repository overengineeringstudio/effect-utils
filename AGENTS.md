# Mono CLI

The `mono` CLI provides shortcuts for common development workflows:

- **TypeScript**: `mono ts [--watch] [--clean]` to type check (use `--clean` to remove build artifacts first)
- **Linting**: `mono lint` or `mono lint --fix` to check/fix formatting and lint issues
- **Testing**: `mono test [--unit|--integration] [--watch]` to run tests
- **Build**: `mono build` to build all packages
- **Clean**: `mono clean` to remove all build artifacts
- **Genie**: `mono genie [--check] [--watch]` to generate config files from `.genie.ts` sources
- **Check**: `mono check` to run all checks (genie + ts + lint + test)

If tools aren't directly in `$PATH`, prefix commands with `direnv exec .` (e.g., `direnv exec . mono ts`).

# Genie (Config File Generation)

Config files like `package.json`, `tsconfig.base.json`, and `.github/workflows/ci.yml` are generated from TypeScript source files using genie. The source files have a `.genie.ts` suffix (e.g., `package.json.genie.ts`).

- **Never edit generated files directly** - they are read-only and will be overwritten
- **Edit the `.genie.ts` source file** and run `mono genie` to regenerate
- Shared constants (catalog versions, tsconfig options) live in `genie/repo.ts`
- `mono check` verifies generated files are up to date via `mono genie --check`

# Changelog

Keep `CHANGELOG.md` updated:

- Add entries under `[Unreleased]` when making changes
- When cutting a release, move `[Unreleased]` entries to a new version section with the release date
