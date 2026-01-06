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
- `exports-first-plugin.js` - custom JS plugin for oxlint

## Linting Rules

| Rule                        | Severity | Description                                   |
| --------------------------- | -------- | --------------------------------------------- |
| `import/no-dynamic-require` | warn     | Disallow dynamic `import()` and `require()`   |
| `oxc/no-barrel-file`        | warn     | Disallow re-exports outside `mod.ts`          |
| `max-params`                | warn     | Encourage named arguments (max 2 params)      |
| `import/no-commonjs`        | error    | Enforce ESM over CommonJS                     |
| `import/no-cycle`           | warn     | Detect circular dependencies                  |
| `func-style`                | warn     | Prefer function expressions over declarations |
| `overeng/exports-first`     | warn     | Exports should come before non-exports        |

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

## Custom JS Plugin

The `overeng/exports-first` rule is implemented as an oxlint JS plugin. JS plugins are experimental - see the [oxlint JS plugins blog post](https://oxc.rs/blog/2025-10-09-oxlint-js-plugins.html).

An upstream feature request for a native `import/exports-first` rule has been filed: https://github.com/oxc-project/oxc/issues/17706

## Future

TypeScript config support (`oxlint.config.ts`) is planned for Q1 2026.
See: https://github.com/oxc-project/oxc/issues/17527
