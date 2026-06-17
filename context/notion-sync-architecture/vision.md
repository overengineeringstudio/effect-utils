# Vision - Notion Sync Architecture

## The Problem

Problem 1: Notion sync packages share concepts such as desired state, observed
state, checkpoints, drift, guards, and mutation plans, but those concepts are
not named or verified in one stack-wide place.

Problem 2: The packages also have different authority models. Datasource
workspaces preserve shared local and remote edits; NotionMD page files guard
Markdown surfaces; React renders an owned Notion region that may overwrite
manual edits inside that region.

Problem 3: Without a hierarchy, follow-up cleanup either duplicates sync
semantics across packages or over-corrects into a shared engine that hides real
product differences.

## The Vision

- One stack-wide source of truth names the sync concepts, responsibility
  boundaries, and evidence requirements shared across Notion sync packages.
- Shared contracts make safety, drift, evidence, and mutation semantics legible
  across packages before implementation is extracted.
- Concrete realizations keep authority models explicit, so datasource
  workspaces, `.nmd` page files, and React-owned regions can reuse contracts
  without inheriting each other's overwrite or conflict policies.

## What This Is Not

- This is not a mandate to create one shared sync engine.
- This is not a replacement for package-local VRS docs.
- This is not a claim that React-owned region sync is the datasource workspace
  planner or the NotionMD clean-base adoption path.

## Success Criteria

1. Stack-wide Notion sync decisions resolve through this VRS tree.
2. Every realization states its authority model, user surface, hidden state,
   mutation boundary, and conflict or drift policy.
3. Shared sync claims identify verification evidence or an explicit evidence
   gap before becoming implementation reuse.
