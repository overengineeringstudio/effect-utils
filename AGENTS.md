# Mono CLI

The `mono` CLI provides shortcuts for common development workflows:

- **TypeScript**: `mono ts [--watch] [--clean]` to type check (use `--clean` to remove build artifacts first)
- **Linting**: `mono lint` or `mono lint --fix` to run/auto-fix linting checks
- **Testing**: `mono test [--unit|--integration] [--watch]` to run tests
- **Build**: `mono build` to build all packages
- **Clean**: `mono clean` to remove all build artifacts
- **Check**: `mono check` to run all checks (ts + lint + test)

If tools aren't directly in `$PATH`, prefix commands with `direnv exec .` (e.g., `direnv exec . mono ts`).

# Changelog

Keep `CHANGELOG.md` updated:
- Add entries under `[Unreleased]` when making changes
- When cutting a release, move `[Unreleased]` entries to a new version section with the release date
