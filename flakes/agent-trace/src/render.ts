import { SchemaAST as AST } from 'effect'

import { footerV4 } from './bindings.ts'
import { lowerView, object } from './projection.ts'
import { annotations, type Audience } from './schema.ts'
// Audience and binding contracts are immutable; lower them once, not for every rendered record.
const footerSchemas = {
  'public-minimal': lowerView({ audience: 'public-minimal', binding: footerV4 }).schema,
  'private-rich': lowerView({ audience: 'private-rich', binding: footerV4 }).schema,
}
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
const get = ({ value, path }: { value: unknown; path: string }): unknown =>
  path.split('.').reduce((v, key) => (v === undefined ? undefined : object(v)[key]), value)
const text = ({ value, path }: { value: unknown; path: string }): string | undefined => {
  const found = get({ value, path })
  return typeof found === 'string' ? found : undefined
}
// q33 wording is deliberately isolated: machine decoding never reads this text.
/** Renders the confirmed accountable-human-first summary, degrading absent observations by omission. */
export const summaryText = (view: unknown): string => {
  const principal = text({ value: view, path: 'who.principal' })?.split(':').at(-1)
  const agent = text({ value: view, path: 'who.agent' }),
    harness = text({ value: view, path: 'how.harness.tool' })
  const seat = agent?.startsWith('agent/') ? agent.slice(6) : undefined
  const mission = text({ value: view, path: 'why.mission.name' })?.replace(
    seat ? seat + '/' : /^$/,
    '',
  )
  const step = text({ value: view, path: 'why.step.name' })
  const identity = principal
    ? '@' + principal + (agent ? ' via ' + (seat ?? 'direct session') : '')
    : (seat ?? (agent ? 'direct session' : undefined))
  const context = [mission ?? (!seat ? harness : undefined), step].filter(Boolean).join(' › ')
  return [identity, context].filter(Boolean).join(' · ')
}
const valueText = ({ ast, value }: { ast: AST.AST; value: unknown }): string => {
  const a = annotations(ast)
  if (AST.isObjects(ast)) {
    const record = object(value)
    return ast.propertySignatures
      .filter((p) => Object.hasOwn(record, String(p.name)))
      .map((p) => valueText({ ast: p.type, value: record[String(p.name)] }))
      .join(a['x-format'] === 'space' ? ' ' : ' · ')
  }
  if (typeof value !== 'string') throw new TypeError('Rendered field is not text')
  return escape(value)
}
/** Renders annotation-driven question-family tables without parsing any human presentation. */
export const renderFooterHuman = ({
  view,
  audience,
}: {
  view: unknown
  audience: Audience
}): string => {
  const schema = footerSchemas[audience],
    record = object(view),
    sections: string[] = []
  if (!AST.isObjects(schema.ast)) throw new TypeError('Footer view is not a struct')
  for (const family of schema.ast.propertySignatures) {
    const name = String(family.name)
    if (!['who', 'why', 'how', 'where'].includes(name) || !Object.hasOwn(record, name)) continue
    const a = annotations(family.type),
      fields = object(record[name]),
      rows: string[] = []
    if (!AST.isObjects(family.type)) throw new TypeError('Question family is not a struct')
    for (const field of family.type.propertySignatures) {
      const key = String(field.name),
        metadata = annotations(field.type)
      if (!metadata['x-row'] || !Object.hasOwn(fields, key)) continue
      let value = fields[key]
      if (name === 'why' && key === 'mission') {
        const mission = object(value),
          seat = text({ value: view, path: 'who.agent' })?.replace(/^agent\//, '')
        const missionName = text({ value: value, path: 'name' })
        if (seat && missionName?.startsWith(seat + '/'))
          value = { ...mission, name: missionName.slice(seat.length + 1) }
      }
      const description =
        metadata.description! + (metadata['x-sensitivity'] === 'internal' ? ' (private only)' : '')
      rows.push(
        `| ${escape(metadata.title!)} | ${valueText({ ast: field.type, value: value })} | \`${name}.${key}\` | ${escape(description)} |`,
      )
    }
    if (rows.length)
      sections.push(
        `**${escape(a.title!)}**\n\n${escape(a.description!)}\n\n| Field | Value | Key | Description |\n|---|---|---|---|\n${rows.join('\n')}`,
      )
  }
  const summary = summaryText(view)
  const heading = text({ value: view, path: 'who.principal' })
    ? 'Posted on behalf of ' + summary
    : text({ value: view, path: 'who.agent' })
      ? 'Posted by ' + summary
      : 'Agent Trace' + (summary ? ' · ' + summary : '')
  return `<details>\n<summary>${escape(heading)}</summary>\n\n${sections.join('\n\n')}\n</details>`
}
/** Renders attribution without claiming an absent accountable principal. */
export const renderTrailerHuman = (view: unknown): string =>
  (text({ value: view, path: 'who.principal' }) ? 'On-Behalf-Of: ' : 'Agent: ') +
  (summaryText(view) || 'Agent Trace')
