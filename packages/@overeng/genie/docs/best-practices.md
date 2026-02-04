# Best Practices

## Writing Generators

- Keep generators simple and focused. Avoid magic and complex logic.

### Type-level design

- When at odds, optimize for catching typos instead of optimizing for autocomplete.

### IDE Support (JSDoc & Jump-to-Definition)

Genie factory functions now provide full IDE support out of the box:

```ts
import { githubRuleset } from '@overeng/genie'

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
})
```

**What you get:**

- **Jump to definition** - Cmd+click on properties navigates to the interface definition
- **JSDoc hover** - Hovering shows property documentation
- **Typo detection** - Extra properties are caught at compile time
- **Literal type preservation** - `const` inference preserves exact types

**How it works:**

Genie uses the "Base-First Intersection" pattern internally:

```ts
const fn = <const T extends Args>(args: Args & Strict<T, Args>): Output<T>
```

This puts the base type (`Args`) first in the intersection, which tells TypeScript to associate JSDoc and source locations with it, while `Strict<T, Args>` still catches typos/extra properties at compile time.

**Note:** The `satisfies` pattern is no longer required. Previous versions required importing an extra type and using `satisfies` at the call site, but this is no longer necessary.
