// Consolidated SYNTHETIC seed data for every demo (public repo — never real
// workspace data). This is the single source of truth the demo-env CLI uses to
// provision each demo's Notion setup, distilled from the demos' own
// setup.sh/seed files:
//   - sqlite:  demo/sqlite/seed/{schema,rows}.json
//   - schema:  demo/schema/setup.sh (People + Tasks typed DBs + rows)
// The md demo's seed .nmd files are read live from demo/md/seed/*.nmd (so their
// content stays defined in exactly one place).

type Json = Record<string, unknown>

// --- sqlite demo: one typed "Launch Tasks" database ------------------------

export const SQLITE_DB_TITLE = 'Launch Tasks (sqlite demo)'

export const SQLITE_PROPERTIES: Json = {
  Name: { title: {} },
  Status: {
    select: {
      options: [
        { name: 'Backlog', color: 'gray' },
        { name: 'In progress', color: 'blue' },
        { name: 'In review', color: 'yellow' },
        { name: 'Done', color: 'green' },
      ],
    },
  },
  Priority: { number: { format: 'number' } },
  Team: {
    select: {
      options: [
        { name: 'Platform', color: 'purple' },
        { name: 'Growth', color: 'orange' },
        { name: 'Infra', color: 'red' },
      ],
    },
  },
  'Effort (h)': { formula: { expression: 'prop("Priority") * 8' } },
}

interface SqliteRow {
  readonly Name: string
  readonly Status: string
  readonly Priority: number
  readonly Team: string
}

export const SQLITE_ROWS: readonly SqliteRow[] = [
  { Name: 'Ship onboarding checklist', Status: 'In progress', Priority: 2, Team: 'Growth' },
  { Name: 'Migrate billing service', Status: 'Backlog', Priority: 3, Team: 'Platform' },
  { Name: 'Fix flaky deploy pipeline', Status: 'In progress', Priority: 1, Team: 'Infra' },
  { Name: 'Draft Q3 roadmap', Status: 'In review', Priority: 2, Team: 'Platform' },
  { Name: 'Add dark mode to dashboard', Status: 'Backlog', Priority: 2, Team: 'Growth' },
  { Name: 'Rotate signing keys', Status: 'Done', Priority: 1, Team: 'Infra' },
]

export const sqliteRowProps = (r: SqliteRow): Json => ({
  Name: { title: [{ text: { content: r.Name } }] },
  Status: { select: { name: r.Status } },
  Priority: { number: r.Priority },
  Team: { select: { name: r.Team } },
})

// --- schema demo: People + Tasks typed databases ---------------------------

export const PEOPLE_PROPERTIES: Json = {
  Name: { type: 'title', title: {}, description: 'Full name of the person' },
  Role: {
    type: 'select',
    description: 'Primary role on the team',
    select: {
      options: [
        { name: 'Engineer', color: 'blue' },
        { name: 'Designer', color: 'purple' },
        { name: 'PM', color: 'green' },
      ],
    },
  },
  Email: { type: 'email', email: {}, description: 'Contact email address' },
  Active: { type: 'checkbox', checkbox: {}, description: 'Whether the person is currently active' },
}

interface PersonRow {
  readonly Name: string
  readonly Role: string
  readonly Email: string
  readonly Active: boolean
}

export const PEOPLE_ROWS: readonly PersonRow[] = [
  { Name: 'Ada Lovelace', Role: 'Engineer', Email: 'ada@example.com', Active: true },
  { Name: 'Grace Hopper', Role: 'PM', Email: 'grace@example.com', Active: true },
  { Name: 'Alan Turing', Role: 'Designer', Email: 'alan@example.com', Active: false },
]

export const personRowProps = (r: PersonRow): Json => ({
  Name: { title: [{ type: 'text', text: { content: r.Name } }] },
  Role: { select: { name: r.Role } },
  Email: { email: r.Email },
  Active: { checkbox: r.Active },
})

/** Tasks properties. `Assignee` relation targets the People data source. */
export const tasksProperties = (peopleDsId: string): Json => ({
  Name: { type: 'title', title: {}, description: 'Short, human-readable task name' },
  Status: { type: 'status', status: {}, description: 'Workflow state of the task' },
  Priority: {
    type: 'select',
    description: 'How urgent this task is',
    select: {
      options: [
        { name: 'High', color: 'red' },
        { name: 'Medium', color: 'yellow' },
        { name: 'Low', color: 'gray' },
      ],
    },
  },
  Tags: {
    type: 'multi_select',
    description: 'Areas of the codebase this task touches',
    multi_select: {
      options: [
        { name: 'Frontend', color: 'blue' },
        { name: 'Backend', color: 'green' },
        { name: 'Design', color: 'purple' },
        { name: 'Bug', color: 'red' },
      ],
    },
  },
  Due: { type: 'date', date: {}, description: 'Target completion date' },
  Estimate: {
    type: 'number',
    description: 'Estimated effort in hours',
    number: { format: 'number' },
  },
  Done: { type: 'checkbox', checkbox: {}, description: 'Whether the task is complete' },
  Spec: { type: 'url', url: {}, description: 'Link to the design doc or spec' },
  Notes: { type: 'rich_text', rich_text: {}, description: 'Free-form context for the task' },
  Assignee: {
    type: 'relation',
    description: 'The person responsible for this task',
    relation: { data_source_id: peopleDsId, type: 'single_property', single_property: {} },
  },
})

interface TaskRow {
  readonly Name: string
  readonly Status: string
  readonly Priority: string
  readonly Tag: string
  readonly Due: string
  readonly Estimate: number
  readonly Done: boolean
}

export const TASK_ROWS: readonly TaskRow[] = [
  { Name: 'Wire up login form', Status: 'In progress', Priority: 'High', Tag: 'Frontend', Due: '2026-07-14', Estimate: 6, Done: false },
  { Name: 'Cache invalidation bug', Status: 'Not started', Priority: 'High', Tag: 'Bug', Due: '2026-07-10', Estimate: 3, Done: false },
  { Name: 'Polish empty states', Status: 'Done', Priority: 'Low', Tag: 'Design', Due: '2026-07-02', Estimate: 2, Done: true },
]

export const taskRowProps = (r: TaskRow, assigneeId: string | undefined): Json => {
  const props: Json = {
    Name: { title: [{ type: 'text', text: { content: r.Name } }] },
    Status: { status: { name: r.Status } },
    Priority: { select: { name: r.Priority } },
    Tags: { multi_select: [{ name: r.Tag }] },
    Due: { date: { start: r.Due } },
    Estimate: { number: r.Estimate },
    Done: { checkbox: r.Done },
    Notes: { rich_text: [{ type: 'text', text: { content: 'Synthetic demo row.' } }] },
  }
  if (assigneeId) props.Assignee = { relation: [{ id: assigneeId }] }
  return props
}
