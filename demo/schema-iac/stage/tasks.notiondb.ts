/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  DESIRED-STATE SOURCE OF TRUTH — for the PLANNED `notion schema apply`.    │
 * │  This capability DOES NOT EXIST YET. This file is a roadmap-preview        │
 * │  artifact (demo "3.2"); the commands in SCREENPLAY.md are narrated, not    │
 * │  run. See ../README.md for the honest boundary.                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The inverse of the shipped codegen demo (demo/schema, "3.1"):
 *
 *   3.1 codegen (real):  live Notion DB is the source of truth
 *                        → `notion schema generate` emits typed code from it
 *                        → `notion schema diff --exit-code` gates drift in CI.
 *
 *   3.2 IaC (this):      THIS FILE is the source of truth
 *                        → `notion schema plan` shows what it WOULD create/change
 *                        → `notion schema apply` reconciles the Notion DB to match.
 *
 * Every property below maps to something the sync engine can already do
 * (add property / add select options; see ../README.md). No destructive or
 * computed types appear here — those fail closed by design.
 */
import { defineDatabase, parentPage, property } from './notiondb.ts'

export default defineDatabase({
  name: 'Tasks',
  // Parent page comes from the environment so no workspace id is ever committed.
  parent: parentPage(process.env.DEMO_PARENT_PAGE),
  properties: {
    // The one title property — set at create, immutable afterward.
    Name: property.title({ description: 'The task' }),

    // select → literal-union of option names. Options are additive-only.
    Status: property.select({
      description: 'Workflow state',
      options: ['Todo', 'In Progress', 'Done'],
    }),
    Priority: property.select({
      description: 'How urgent',
      options: [
        { name: 'High', color: 'red' },
        { name: 'Medium', color: 'yellow' },
        { name: 'Low', color: 'gray' },
      ],
    }),

    // multi_select → set of option names, also additive-only.
    Tags: property.multiSelect({
      description: 'Free-form labels',
      options: ['bug', 'feature', 'chore'],
    }),

    Estimate: property.number({ description: 'Story points' }),
    'Due Date': property.date({ description: 'When it is due' }),
    Done: property.checkbox({ description: 'Closed out' }),
    'Ticket URL': property.url({ description: 'Link to the issue' }),
    Notes: property.richText({ description: 'Anything else' }),
  },
})
