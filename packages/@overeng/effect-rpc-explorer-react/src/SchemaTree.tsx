import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import {
  Button,
  Disclosure,
  DisclosurePanel,
  Tree,
  TreeItem,
  TreeItemContent,
} from 'react-aria-components'

import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import {
  schemaObject as object,
  schemaProperties as properties,
  schemaText as text,
  type SchemaObject,
} from './schema-field.ts'
import { explorerTokens } from './tokens.stylex.ts'
/** Safely interprets projected JSON Schema metadata without decoding captured content. */
export { SchemaTree }

const styles = stylex.create({
  tree: {
    display: 'grid',
    minWidth: 0,
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  row: {
    minWidth: 0,
    paddingBlock: spacing['0.5'],
    paddingInlineStart: `calc((var(--tree-item-level) - 1) * ${spacing[3]})`,
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  labelLine: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing[1] },
  trigger: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: spacing[1],
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: explorerTokens.text,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  name: { fontFamily: explorerTokens['font-data'], color: explorerTokens.text },
  type: { color: explorerTokens.info, fontFamily: explorerTokens['font-data'] },
  noteDisclosure: { display: 'inline-block', marginInlineStart: spacing[2] },
  muted: { color: explorerTokens['muted-text'] },
  note: {
    marginBlock: spacing['0.5'],
    color: explorerTokens['muted-text'],
    overflowWrap: 'anywhere',
  },
})

const kind = (schema: SchemaObject): string => {
  const type = schema.type
  if (typeof type === 'string') return type
  if (Array.isArray(type) === true)
    return type.filter((item): item is string => typeof item === 'string').join(' | ')
  if (Array.isArray(schema.enum) === true) return schema.enum.map(String).join(' | ')
  if (Array.isArray(schema.anyOf) === true) return 'any of'
  if (Array.isArray(schema.oneOf) === true) return 'one of'
  if (typeof schema.$ref === 'string') return 'reference'
  return 'value'
}

const SchemaNode = ({
  schema,
  name,
  required,
  depth,
  defs,
  id,
}: {
  schema: SchemaObject
  name: string
  required: boolean
  depth: number
  defs: SchemaObject | undefined
  id: string
}): ReactNode => {
  const reference = text(schema.$ref)
  const resolved =
    reference?.startsWith('#/$defs/') === true
      ? (object(defs?.[reference.slice('#/$defs/'.length)]) ?? schema)
      : schema
  const fields = properties(resolved)
  const item = object(resolved.items)
  const children = fields.length > 0 ? fields : item === undefined ? [] : [['items', item] as const]
  const title = text(schema.title) ?? text(resolved.title) ?? name
  const description = text(schema.description) ?? text(resolved.description)
  const examples =
    Array.isArray(schema.examples) === true
      ? schema.examples
      : Array.isArray(resolved.examples) === true
        ? resolved.examples
        : []
  const hasNotes = description !== undefined || examples.length > 0
  const label = (
    <span {...stylex.props(styles.labelLine)}>
      <span {...stylex.props(styles.name)}>{title}</span>
      {title === name || depth === 0 ? undefined : (
        <span {...stylex.props(styles.muted)}>({name})</span>
      )}
      <span {...stylex.props(styles.type)}>{kind(resolved)}</span>
      {required === true ? undefined : <span {...stylex.props(styles.muted)}>optional</span>}
    </span>
  )
  const requiredFields = new Set(Array.isArray(resolved.required) === true ? resolved.required : [])
  const labelText = `${title} ${kind(resolved)} ${required === true ? 'required' : 'optional'}`
  return (
    <TreeItem id={id} textValue={labelText} aria-label={labelText} {...stylex.props(styles.row)}>
      <TreeItemContent>
        {({ isExpanded }) => (
          <>
            {children.length > 0 && depth < 8 ? (
              <Button
                slot="chevron"
                aria-label={`${isExpanded === true ? 'Collapse' : 'Expand'} ${title}`}
                {...stylex.props(styles.trigger)}
              >
                <span aria-hidden="true">{isExpanded === true ? '▾' : '▸'}</span>
              </Button>
            ) : undefined}
            {label}
            {hasNotes === true ? (
              <Disclosure {...stylex.props(styles.noteDisclosure)}>
                <Button
                  slot="trigger"
                  aria-label={`Schema notes for ${title}`}
                  {...stylex.props(styles.trigger, styles.muted)}
                >
                  Notes
                </Button>
                <DisclosurePanel>
                  {description === undefined ? undefined : (
                    <div {...stylex.props(styles.note)}>{description}</div>
                  )}
                  {examples.length === 0 ? undefined : (
                    <div {...stylex.props(styles.note)}>
                      Example: {examples.map((example) => JSON.stringify(example)).join(', ')}
                    </div>
                  )}
                </DisclosurePanel>
              </Disclosure>
            ) : undefined}
          </>
        )}
      </TreeItemContent>
      {depth >= 8
        ? undefined
        : children.map(([key, child]) => (
            <SchemaNode
              key={key}
              id={`${id}/${encodeURIComponent(key)}`}
              schema={child}
              name={key}
              required={requiredFields.has(key)}
              depth={depth + 1}
              defs={defs}
            />
          ))}
    </TreeItem>
  )
}

const SchemaTree = ({ document }: { document: unknown }): ReactNode => {
  const root = object(document)
  const schema = root === undefined ? undefined : (object(root.schema) ?? root)
  if (schema === undefined)
    return <p {...stylex.props(styles.muted)}>No projected schema available.</p>
  return (
    <Tree
      aria-label="Projected channel schema"
      selectionMode="none"
      defaultExpandedKeys={['root']}
      {...stylex.props(styles.tree)}
    >
      <SchemaNode
        id="root"
        schema={schema}
        name="Schema"
        required
        depth={0}
        defs={object(root?.$defs)}
      />
    </Tree>
  )
}
