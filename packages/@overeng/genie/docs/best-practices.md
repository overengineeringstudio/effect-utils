# Best Practices

## Writing Generators

- Keep generators simple and focused. Avoid magic and complex logic.

### Type-level design

- When at odds, optimize for catching typos instead of optimizing for autocomplete.

### Using `satisfies` for IDE support

When calling genie factory functions, use `satisfies` at the call site to enable full IDE support:

```ts
import { githubRuleset, type GithubRulesetArgs } from '@overeng/genie'

export default githubRuleset({
  name: 'protect-main',
  rules: [
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true, // ✅ JSDoc/jump-to-def works!
        required_status_checks: [{ context: 'ci' }],
      },
    },
  ],
} satisfies GithubRulesetArgs)
```

**Why this pattern?**

Genie uses `Strict<T, TBase>` generics to catch typos (extra properties) at compile time while preserving literal types. However, TypeScript doesn't "back-propagate" JSDoc or source locations from the constraint type to the inferred literal. Adding `satisfies` tells TypeScript to check the object against the expected type, which enables:

- **Jump to definition** - Cmd+click on properties navigates to the interface definition
- **JSDoc hover** - Hovering shows property documentation
- **Typo detection** - Both from `Strict` and from `satisfies`
- **Literal type preservation** - `const` inference happens before `satisfies`

**Available types:**

| Factory            | Type to use with `satisfies` |
| ------------------ | ---------------------------- |
| `githubRuleset()`  | `GithubRulesetArgs`          |
| `githubWorkflow()` | `GitHubWorkflowArgs`         |
| `packageJson()`    | `PackageJsonData`            |
| `tsconfigJson()`   | `TSConfigArgs`               |
| `oxlintConfig()`   | `OxlintConfigArgs`           |
| `oxfmtConfig()`    | `OxfmtConfigArgs`            |
| `megarepoJson()`   | `MegarepoConfigArgs`         |

For workspace root and pnpm workspace projections, prefer the composition
wrappers:

- `packageJson.aggregate(...)`
- `packageJson.aggregateFromPackages(...)`
- `pnpmWorkspaceYaml.root(...)`

Treat the `packages` array in these helpers as the single source of truth for
workspace membership. If something belongs in the workspace, include its
package generator output rather than maintaining a parallel path list.
`pnpmWorkspaceYaml.manual(...)` is an escape hatch for rare cases where a
workspace member is intentionally not genie-managed (e.g. a vendored third-party
package). Prefer adding a package generator output to `packages` instead.
