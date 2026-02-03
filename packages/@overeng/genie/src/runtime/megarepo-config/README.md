# megarepo-config

Generate `megarepo.json` files with type-safe configuration for megarepo workspaces.

## Usage

```ts
import { megarepoJson } from '@overeng/genie/runtime'

export default megarepoJson({
  members: {
    effect: 'effect-ts/effect',
    'effect-next': 'effect-ts/effect#next',
    'effect-v3': 'effect-ts/effect#v3.0.0',
    'local-lib': '../shared/lib',
  },
  generators: {
    nix: { enabled: true },
    vscode: { enabled: true, exclude: ['large-repo'] },
  },
})
```

## Features

- **Type-safe configuration**: All megarepo options are fully typed
- **Member source formats**: Supports GitHub shorthand, URLs, and local paths
- **Generator config**: Configure nix and vscode generators
- **Programmatic generation**: Use TypeScript to compute members dynamically

## Programmatic Member Generation

Generate members from arrays or other data sources:

```ts
import { megarepoJson } from '@overeng/genie/runtime'

const effectPackages = ['effect', 'schema', 'platform', 'cli'] as const

export default megarepoJson({
  members: Object.fromEntries(effectPackages.map((name) => [name, `effect-ts/${name}`])),
})
```

## Member Source Formats

| Format           | Example                          | Description                |
| ---------------- | -------------------------------- | -------------------------- |
| GitHub shorthand | `owner/repo`                     | Default branch             |
| GitHub with ref  | `owner/repo#branch`              | Specific branch/tag/commit |
| HTTPS URL        | `https://github.com/owner/repo`  | Full URL                   |
| SSH URL          | `git@github.com:owner/repo`      | SSH clone URL              |
| Local path       | `./path`, `../path`, `/abs/path` | Local directory            |

## Generator Options

```ts
{
  generators: {
    // Nix lock sync (default: disabled)
    nix: {
      enabled: true,
    },

    // VSCode workspace file (default: disabled)
    vscode: {
      enabled: true,
      exclude: ['member-to-exclude'],
    },
  }
}
```
