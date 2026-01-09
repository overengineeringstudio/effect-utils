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
      steps: [
        { uses: 'actions/checkout@v4' },
        { run: 'npm test' },
      ],
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

## Type Reference

See [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) for detailed documentation on all options.
