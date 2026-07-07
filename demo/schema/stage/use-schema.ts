/**
 * Tiny consumer of the generated schema — this is where the type-safety is
 * VISIBLE. Open it next to `schema.gen.ts` and hover/autocomplete:
 *
 *   - `task.Priority` decodes to `Option<{ name: 'High' | 'Medium' | 'Low', … }>`
 *     — the literal union of option names comes straight from the live Notion
 *     database's select options.
 *   - Typos in an option name are compile errors, not runtime surprises.
 *
 * Nothing here is hand-written type plumbing: it all flows from `schema.gen.ts`,
 * which was generated from the real database by `notion schema generate-config`.
 */
import { Option } from 'effect'

import { decodeTasksProperties, type TasksPageProperties } from './schema.gen.ts'

// 1. Decode a raw Notion page payload into a fully-typed object.
declare const rawNotionProperties: unknown
const task: TasksPageProperties = decodeTasksProperties(rawNotionProperties)

// 2. Typed field access — the editor knows every property and its shape.
//    `Priority` is an Option whose `.name` is the exact literal union of options.
const priority = task.Priority

// 3. Branch on the typed value. Autocomplete offers 'High' | 'Medium' | 'Low'
//    for `p.name`; a typo like 'Hgh' is a compile error.
const label = Option.match(priority, {
  onNone: () => 'unprioritized',
  onSome: (p) => (p.name === 'High' ? 'do it now' : 'later'),
})

export { task, priority, label }
