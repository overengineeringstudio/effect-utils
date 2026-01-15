# CLI Output Style Guide

General principles for designing CLI output that is readable, actionable, and information-dense.

> **Reference Implementation:** [`reference-output.ts`](./reference-output.ts)
>
> Run `bun reference-output.ts` to see a live example with colors.

## Core Principles

1. **Problems first** - Surface issues at the top before detailed listings
2. **Actionable** - Provide fix commands for every problem
3. **Scannable** - Use visual hierarchy, colors, and spacing effectively
4. **Information-dense** - Compact but not cramped; one concept per line
5. **No emojis** - Use symbols and typography instead

## Output Structure

```
<context-header>

<CRITICAL section>     # Blocking issues (if any)

<WARNING section>      # Non-blocking issues (if any)

<separator>            # Only if problems exist

<main-content>

<summary-line>
```

## Severity Badges

Use background-colored badges for problem sections:

| Severity | Style | Use Case |
|----------|-------|----------|
| `CRITICAL` | White bold on red bg | Blocking issues that prevent work |
| `WARNING` | Black bold on yellow bg | Issues needing attention but not blocking |

**Format:**
```
 CRITICAL              # Note: leading space for padding

  <item> <description>
    <context>
    fix: <command>
    skip: <command>
```

## Problem Items

Each problem item follows this structure:

```
  <name> <status> <details>
    <context-line>           # Optional: additional context
    fix: <command>           # Cyan prefix, one per line
    fix: <command>           # Multiple fix options allowed
    skip: <command>          # Dimmed, how to ignore/suppress
```

**Styling:**
- Item name: **bold**
- Status/description: dimmed
- Details (hashes, counts): dimmed, in parentheses
- `fix:` prefix: cyan
- `skip:` prefix: dimmed
- Commands: regular weight

**Grouping similar issues:**
```
  4 repos have uncommitted changes
    repo1, repo2, repo3, repo4
    fix: <batch-command>
    fix: <individual-command>
```

## Main Content Items

For listing items (repos, packages, resources):

```
<name> <branch>@<hash> <status-symbols> <relationship>

  <subsection>(<count>):
    <item>
    <item>
    + N more
```

**Styling:**
- Name: **bold**
- Branch/ref: colored by type
  - Default/main: green
  - Feature branches: magenta
  - Detached HEAD: blue
- Hash: dimmed, prefixed with `@`, 7-8 chars
- Status symbols: colored (see below)
- Relationship: dimmed, with prefix like `←`

## Status Symbols

| Symbol | Meaning | Color |
|--------|---------|-------|
| `*` | Modified/dirty | Yellow |
| `↕<ref>` | Diverged/out-of-sync | Red |
| `✓` | OK/synced | Green |
| `✗` | Error/missing | Red |

Place symbols inline after the identifier:
```
myproject main@abc1234 * ↕def5678
```

## List Truncation

When lists exceed a reasonable length:

```
  items(24):
    @scope/item-one
    @scope/item-two
    @scope/item-three
    @scope/item-four
    @scope/item-five
    + 19 more
```

**Rules:**
- Show count in header: `items(24):`
- Display max 5 items
- Show `+ N more` in dimmed text
- Header and count are dimmed

## Separators

Use a dimmed horizontal line to separate sections:

```
────────────────────────────────────────
```

- 40 characters wide
- Dimmed color
- Only show when separating distinct sections (e.g., problems from content)

## Summary Line

End with a concise summary:

```
4 members · 2 deps · 6 repos
```

- Dimmed text
- Use `·` (middle dot) as separator
- Include relevant counts

## Color Reference

| Element | ANSI Code | Usage |
|---------|-----------|-------|
| Bold | `\x1b[1m` | Names, emphasis |
| Dim | `\x1b[2m` | Secondary info, hints |
| Red | `\x1b[31m` | Errors, diverged |
| Green | `\x1b[32m` | Success, main branch |
| Yellow | `\x1b[33m` | Warnings, dirty |
| Blue | `\x1b[34m` | Info, detached HEAD |
| Magenta | `\x1b[35m` | Feature branches |
| Cyan | `\x1b[36m` | Commands, links |
| Bg Red | `\x1b[41m` | CRITICAL badge |
| Bg Yellow | `\x1b[43m` | WARNING badge |
| Reset | `\x1b[0m` | Reset formatting |

## Spacing

- **Between problem items:** 1 blank line
- **Between main content items:** 1 blank line
- **After section badges:** 1 blank line
- **Before separator:** 1 blank line
- **No trailing blank lines** at end of output

## Conditional Display

| Condition | Behavior |
|-----------|----------|
| No problems | Omit CRITICAL, WARNING, and separator |
| No items in section | Omit entire section |
| Empty subsection | Omit subsection |
| All items OK | Omit status symbols |

## Example: Full Output with Problems

```
workspace2

 CRITICAL

  missing-dep missing
    Required by: project-a, project-b
    fix: tool clone missing-dep
    fix: git clone <url> repos/missing-dep
    skip: tool ignore missing-dep

 WARNING

  project-a diverged (local: abc1234, remote: def5678)
    fix: cd project-a && git pull --rebase
    fix: tool sync project-a
    skip: tool ignore project-a --diverged

  3 repos have uncommitted changes
    project-a, project-b, project-c
    fix: tool commit -a
    fix: git status <repo> to review

────────────────────────────────────────

project-a main@abc1234 * ↕def5678 ← shared-lib

project-b feature/new@789abcd * ← shared-lib
  packages(12):
    @scope/package-one
    @scope/package-two
    @scope/package-three
    @scope/package-four
    @scope/package-five
    + 7 more

project-c HEAD@fedcba9 * ← shared-lib

4 members · 1 dep
```

## Example: Clean Output (No Problems)

```
workspace2

project-a main@abc1234 ← shared-lib

project-b feature/new@789abcd ← shared-lib
  packages(12):
    @scope/package-one
    @scope/package-two
    @scope/package-three
    @scope/package-four
    @scope/package-five
    + 7 more

project-c HEAD@fedcba9 ← shared-lib

4 members · 1 dep
```

## Anti-Patterns

- **Don't** use emojis for status indicators
- **Don't** use full-width banners or boxes for every section
- **Don't** repeat information (e.g., showing problem in both sections)
- **Don't** show empty sections or placeholder text
- **Don't** use colors without semantic meaning
- **Don't** truncate without indicating how many items remain
- **Don't** mix action styles (pick `fix:` or `→`, not both)
