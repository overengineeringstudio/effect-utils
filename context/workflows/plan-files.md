# Plan Files

## Directory Structure

Each task lives in its own directory under `<repo>/tasks/`:

```
tasks/
├── 2026-01-15-effect-atom-migration/
│   ├── plan.md
│   └── worklog.md
├── 2026-01-16-fix-auth-flow/
│   ├── plan.md
│   └── worklog.md
```

## Task ID Format

Use sortable date-prefixed IDs: `YYYY-MM-DD-<slug>`

- Date is when the task was created
- Slug is a short, descriptive identifier (kebab-case)
- Examples: `2026-01-15-effect-atom-migration`, `2026-01-16-fix-auth-flow`

## Plan File (`plan.md`)

The plan should include:

- **Problem statement**: What problem are we solving?
- **Goal**: What does success look like?
- **Constraints**: Any limitations or requirements
- **Proposed solution**: How we plan to solve it
- **Alternatives considered**: Other approaches and why they were rejected
- **Open questions**: Unresolved decisions
- **Implementation phases**: Structured tasks that can be checked off (e.g. `[x] task 1`, `[ ] task 2`)
  - If refactoring, include cleanup phase to remove unused/duplicate code
- **Iteration/feedback loop**: How to test and verify the work is correct

## Worklog File (`worklog.md`)

Track work done chronologically:

```markdown
# Worklog

## YYYY-MM-DD

### What was done
- Item 1
- Item 2

### Blockers / Issues
- Issue encountered

### Next steps
- What to do next
```