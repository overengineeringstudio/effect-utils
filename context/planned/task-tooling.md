# Task Tooling

Unified tooling for task/issue management that integrates with agent workflows.

## Problem Statement

Current pain points:

- No structured way to link agent sessions to tasks/issues
- Task type classification is manual
- Plan progress isn't tracked in a machine-readable way
- No cross-repo task visibility

## Options Considered

- Beads
- Dots
- Notion
- Linear
- Custom solution

## Requirements

### Core

- [ ] Works across repos (not tied to a single codebase)
- [ ] Allows sharing (e.g., share tasks for livestore, external collaborators)
- [ ] Agent can follow the process (e.g., keep plan up to date automatically)
- [ ] Machine-readable task metadata for integration with agent manager

### Task Document Structure

Each task should have:

**Agent info:**

- Tool (claude-code, opencode, etc.)
- Model (e.g., opus-4.5)
- Session IDs (multiple agents can work on same task over time)

**Separate files/aspects:**

- Plan/spec (versioned: v1, v2, etc.)
- Research artifacts
- Decision tree
- Worklog (including decisions made by user + agent)

**Metadata:**

- Unique task ID (e.g., `OE-123`)
- Task type (bug, feature, refactor, research, test, docs, config)
- Status (planning, in-progress, blocked, completed, failed)
- Links to related sessions

### Integration with Agent Manager

The task tooling should provide data that SessionCardV7 can consume:

| Field          | Source                     |
| -------------- | -------------------------- |
| `issueId`      | Task document ID           |
| `taskType`     | Task document metadata     |
| `isPlanning`   | Task document status/phase |
| `planProgress` | Task document phases/tasks |

### API Surface (Draft)

```
task create <title>           # Create new task, returns ID
task link <task-id>           # Link current session to task
task status                   # Show current task status
task progress <phase> <task>  # Update progress
task complete [--failed]      # Mark task as done
```

## Challenges

- Agent needs to follow the process reliably
- Syncing state between task documents and agent sessions
- Handling task evolution (plan changes mid-execution)

## Open Questions

- Where do task documents live? (repo-local vs centralized)
- How to handle tasks that span multiple repos?
- Version control for task documents?
- How to bootstrap from existing sessions without task links?

---

## Related

- Session Card Enrichment: `oi/tasks/2026-01-17-session-card-enrichment/`
- Plan Files Workflow: `context/workflows/plan-files.md`
