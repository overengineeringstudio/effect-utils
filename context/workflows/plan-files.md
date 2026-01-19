# Plan Files

Plan files are temporary, **unversioned** artifacts used during active work. The `tasks/` directory is gitignored - these files exist only on local machines during development. Once a task is completed, the entire task directory should be deleted. The work is captured in the codebase and git history, not in these files.

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

## Lifecycle

1. **Create**: When starting a new task, create the task directory with `plan.md`
2. **Work**: Track progress in `worklog.md` as you work
3. **Complete**: Once the task is done and merged, delete the entire task directory
4. **Never reference**: Do not reference plan files from code, docs, or commit messages - they are ephemeral
