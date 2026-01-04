# @overeng/oxc-config

Shared oxlint and oxfmt configuration for overeng projects.

## Usage

### Linting with oxlint

```bash
oxlint -c packages/@overeng/oxc-config/lint.jsonc --import-plugin
```

### Formatting with oxfmt

```bash
oxfmt -c packages/@overeng/oxc-config/fmt.jsonc .
```

## Config Files

- `lint.jsonc` - oxlint rules and overrides
- `fmt.jsonc` - oxfmt formatting and import sorting

## Linting Rules

| Rule                        | Severity | Description                                   |
| --------------------------- | -------- | --------------------------------------------- |
| `import/no-dynamic-require` | warn     | Disallow dynamic `import()` and `require()`   |
| `oxc/no-barrel-file`        | warn     | Detect barrel files with >10 re-exports       |
| `max-params`                | warn     | Encourage named arguments (max 2 params)      |
| `import/no-commonjs`        | error    | Enforce ESM over CommonJS                     |
| `import/no-cycle`           | warn     | Detect circular dependencies                  |
| `func-style`                | warn     | Prefer function expressions over declarations |

## Lint Categories

- `correctness`: error
- `suspicious`: warn
- `perf`: warn
- `pedantic`: off
- `style`: off
- `restriction`: off

## Format Settings

- Single quotes, no semicolons
- 100 char line width, 2 space indent
- Import sorting with newlines between groups:
  1. External packages (`effect`, `@effect/*`)
  2. Internal monorepo (`@overeng/*`)
  3. Relative imports (`./`, `../`)

## Future

TypeScript config support (`oxlint.config.ts`) is planned for Q1 2026.
See: https://github.com/oxc-project/oxc/issues/17527
