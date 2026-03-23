# github-workflow

Generate GitHub Actions workflow YAML files with full type safety.

## Usage

```ts
import { githubWorkflow } from '@overeng/genie/lib'

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: {
    test: {
      'runs-on': 'ubuntu-latest',
      steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm test' }],
    },
  },
})
```

## Features

- **Type-safe**: All workflow fields, triggers, and job configurations are fully typed
- **Complete coverage**: Supports all GitHub Actions workflow syntax including:
  - All event triggers (push, pull_request, schedule, workflow_dispatch, etc.)
  - Job configuration (runs-on, needs, strategy, matrix, etc.)
  - Step types (run steps, uses steps)
  - Permissions, concurrency, environment settings
- **YAML output**: Generates properly formatted YAML

## Validation

`githubWorkflow()` validates each job's `runs-on` value before emitting YAML.

This rejects invalid runner labels such as:

- empty `runs-on` arrays
- non-string labels
- empty string labels
- stale placeholder labels like `namespace-features:github.run-id=undefined`

This is mainly intended to catch CI helper API drift early. Without this validation, stale generated workflows can look superficially valid in the repo but only fail later when GitHub tries to load or schedule the workflow.

## Type Reference

See [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) for detailed documentation on all options.
